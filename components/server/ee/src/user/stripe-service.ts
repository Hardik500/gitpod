/**
 * Copyright (c) 2022 Gitpod GmbH. All rights reserved.
 * Licensed under the Gitpod Enterprise Source Code License,
 * See License.enterprise.txt in the project root folder.
 */

import { inject, injectable } from "inversify";
import Stripe from "stripe";
import { Config } from "../../../src/config";
import { log } from "@gitpod/gitpod-protocol/lib/util/logging";
import { AttributionId } from "@gitpod/gitpod-protocol/lib/attribution";

const POLL_CREATED_CUSTOMER_INTERVAL_MS = 1000;
const POLL_CREATED_CUSTOMER_MAX_ATTEMPTS = 30;

@injectable()
export class StripeService {
    @inject(Config) protected readonly config: Config;

    protected _stripe: Stripe | undefined;

    protected getStripe(): Stripe {
        if (!this._stripe) {
            if (!this.config.stripeSecrets?.secretKey) {
                throw new Error("Stripe is not properly configured");
            }
            this._stripe = new Stripe(this.config.stripeSecrets.secretKey, { apiVersion: "2020-08-27" });
        }
        return this._stripe;
    }

    async createSetupIntent(): Promise<Stripe.SetupIntent> {
        return await this.getStripe().setupIntents.create({ usage: "on_session" });
    }

    async findCustomerByAttributionId(attributionId: string): Promise<string | undefined> {
        const query = `metadata['attributionId']:'${attributionId}'`;
        const result = await this.getStripe().customers.search({ query });
        if (result.data.length > 1) {
            throw new Error(`Found more than one Stripe customer for query '${query}'`);
        }
        return result.data[0]?.id;
    }

    async createCustomerForAttributionId(
        attributionId: string,
        preferredCurrency: string,
        billingEmail?: string,
        billingName?: string,
    ): Promise<string> {
        if (await this.findCustomerByAttributionId(attributionId)) {
            throw new Error(`A Stripe customer already exists for '${attributionId}'`);
        }
        // Create the customer in Stripe
        const customer = await this.getStripe().customers.create({
            email: billingEmail,
            name: billingName,
            metadata: { attributionId, preferredCurrency },
        });
        // Wait for the customer to show up in Stripe search results before proceeding
        let attempts = 0;
        while (!(await this.findCustomerByAttributionId(attributionId))) {
            await new Promise((resolve) => setTimeout(resolve, POLL_CREATED_CUSTOMER_INTERVAL_MS));
            if (++attempts > POLL_CREATED_CUSTOMER_MAX_ATTEMPTS) {
                throw new Error(`Could not confirm Stripe customer creation for '${attributionId}'`);
            }
        }
        return customer.id;
    }

    async setDefaultPaymentMethodForCustomer(customerId: string, setupIntentId: string): Promise<void> {
        const setupIntent = await this.getStripe().setupIntents.retrieve(setupIntentId);
        if (typeof setupIntent.payment_method !== "string") {
            throw new Error("The provided Stripe SetupIntent does not have a valid payment method attached");
        }
        // Attach the provided payment method to the customer
        await this.getStripe().paymentMethods.attach(setupIntent.payment_method, {
            customer: customerId,
        });
        const paymentMethod = await this.getStripe().paymentMethods.retrieve(setupIntent.payment_method);
        await this.getStripe().customers.update(customerId, {
            invoice_settings: { default_payment_method: setupIntent.payment_method },
            ...(paymentMethod.billing_details.address?.country
                ? { address: { line1: "", country: paymentMethod.billing_details.address?.country } }
                : {}),
        });
    }

    async getPortalUrlForAttributionId(attributionId: string, returnUrl: string): Promise<string> {
        const customerId = await this.findCustomerByAttributionId(attributionId);
        if (!customerId) {
            throw new Error(`No Stripe Customer ID found for '${attributionId}'`);
        }
        const session = await this.getStripe().billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
        });
        return session.url;
    }

    async findUncancelledSubscriptionByAttributionId(attributionId: string): Promise<string | undefined> {
        const customerId = await this.findCustomerByAttributionId(attributionId);
        if (!customerId) {
            return undefined;
        }
        const result = await this.getStripe().subscriptions.list({
            customer: customerId,
        });
        if (result.data.length > 1) {
            throw new Error(`Stripe customer '${customerId}') has more than one subscription!`);
        }
        return result.data[0]?.id;
    }

    async cancelSubscription(subscriptionId: string): Promise<void> {
        await this.getStripe().subscriptions.del(subscriptionId);
    }

    async createSubscriptionForCustomer(customerId: string, attributionId: string): Promise<void> {
        const customer = await this.getStripe().customers.retrieve(customerId, { expand: ["tax"] });
        if (!customer || customer.deleted) {
            throw new Error(`Stripe customer '${customerId}' could not be found`);
        }
        const attrId = AttributionId.parse(attributionId);
        if (!attrId) {
            throw new Error(`Invalid attributionId '${attributionId}'`);
        }
        const currency = customer.metadata.preferredCurrency || "USD";
        let priceIds: { [currency: string]: string } | undefined;
        if (attrId.kind === "team") {
            priceIds = this.config.stripeConfig?.teamUsagePriceIds;
        } else if (attrId.kind === "user") {
            priceIds = this.config.stripeConfig?.individualUsagePriceIds;
        } else {
            throw new Error(`Unsupported attribution kind '${(attrId as any).kind}'`);
        }
        const priceId = priceIds && priceIds[currency];
        if (!priceId) {
            throw new Error(
                `No Stripe Price ID configured for attribution kind '${attrId.kind}' and currency '${currency}'`,
            );
        }
        const isAutomaticTaxSupported = customer.tax?.automatic_tax === "supported";
        if (!isAutomaticTaxSupported) {
            log.warn("Automatic Stripe tax is not supported for this customer", {
                customerId,
                taxInformation: customer.tax,
            });
        }
        const startOfNextMonth = new Date(new Date().toISOString().slice(0, 7) + "-01"); // First day of this month (YYYY-MM-01)
        startOfNextMonth.setMonth(startOfNextMonth.getMonth() + 1); // Add one month
        await this.getStripe().subscriptions.create({
            customer: customer.id,
            items: [{ price: priceId }],
            automatic_tax: { enabled: isAutomaticTaxSupported },
            billing_cycle_anchor: Math.round(startOfNextMonth.getTime() / 1000),
        });
    }
}
