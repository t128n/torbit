declare const BUILD_VERSION: string | undefined;

/** Set at build time: bun build --define BUILD_VERSION='"<VERSION file>"' (scripts/build.ts). */
export const version: string = typeof BUILD_VERSION === "string" ? BUILD_VERSION : "dev";
