export const URL_SCHEMES = Object.freeze(["syncky", "syncky-dev", "syncky-staging"]);

export const isUrlScheme = (value) => URL_SCHEMES.includes(value);
