/** Release-controlled flags shared by main and the renderer.
 * Remote booleans override bundled defaults. Missing/malformed values do
 * not accidentally release unfinished work. Legacy local experiment opt-ins are ignored.
 */
const FeaturePolicy = {
    defaults: Object.freeze({ brokerage: false, teach: false, sharing: false, mobilesync: false }),

    resolve(...configs) {
        const flags = { ...this.defaults };
        for (const config of configs) {
            const values = config?.featureFlags;
            if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
            for (const [name, value] of Object.entries(values)) {
                if (typeof value === 'boolean' && name !== '__proto__') flags[name] = value;
            }
        }
        return flags;
    },

    enabled(name, defaults, releaseFlags) {
        if (!Object.prototype.hasOwnProperty.call(defaults, name)) return false;
        if (Object.prototype.hasOwnProperty.call(releaseFlags, name)) return releaseFlags[name] === true;
        return defaults[name] === true;
    },
};

if (typeof module !== 'undefined') module.exports = FeaturePolicy;
