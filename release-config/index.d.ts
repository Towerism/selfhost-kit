/** A semantic-release plugin: its name, or its name and options. */
export type PluginSpec = string | [string, Record<string, unknown>];

/** The apps' shared semantic-release config. Use it with `"extends": "@towerism/selfhost-kit/release-config"`. */
declare const config: {
  branches: string[];
  tagFormat: string;
  plugins: PluginSpec[];
};
export default config;
