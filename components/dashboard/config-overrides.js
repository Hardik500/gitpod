const webpack = require("webpack");

// module.exports = function override(config, env) {
//     console.log("React app rewired works!");
//     config.resolve.fallback = {
//         ...config.resolve.fallback,
//         crypto: false,
//         path: false,
//         os: false,
//         net: false,
//         stream: require.resolve("stream-browserify"),
//         buffer: require.resolve("buffer"),
//     };
//     config.plugins = [
//         ...config.plugins,
//         new webpack.ProvidePlugin({
//             process: "process/browser",
//             Buffer: ["buffer", "Buffer"],
//         }),
//     ];
//     config.devServer = {
//         ...(config.devServer || {}),
//         proxy: {
//             "/api": {
//                 target: "https://" + process.env.GP_DEV_HOST,
//                 ws: true,
//                 headers: {
//                     host: process.env.GP_DEV_HOST,
//                     origin: "https://" + process.env.GP_DEV_HOST,
//                     cookie: process.env.GP_DEV_COOKIE,
//                 },
//             },
//         },
//     };
//     return config;
// };

module.exports = {
    webpack: function (config, env) {
        config.resolve.fallback = {
            ...config.resolve.fallback,
            crypto: false,
            path: false,
            os: false,
            net: false,
            stream: require.resolve("stream-browserify"),
            buffer: require.resolve("buffer"),
        };
        config.plugins = [
            ...config.plugins,
            new webpack.ProvidePlugin({
                process: "process/browser",
                Buffer: ["buffer", "Buffer"],
            }),
        ];
        return config;
    },
    devServer: function (configFunction) {
        return function (proxy, allowedHost) {
            // Create the default config by calling configFunction with the proxy/allowedHost parameters
            const config = configFunction(proxy, allowedHost);
            console.log(config);
            // Change the dev server's config here...
            // Then return your modified config.
            return config;
        };
    }
};
