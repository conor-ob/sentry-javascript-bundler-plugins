import fs from "fs";
import { glob } from "glob";
import os from "os";
import path from "path";
import * as util from "util";
import { Logger } from "./sentry/logger";
import { promisify } from "util";
import { Hub, NodeClient } from "@sentry/node";
import SentryCli from "@sentry/cli";

interface RewriteSourcesHook {
  (source: string, map: any): string;
}

interface DebugIdUploadPluginOptions {
  logger: Logger;
  assets?: string | string[];
  ignore?: string | string[];
  releaseName?: string;
  dist?: string;
  rewriteSourcesHook?: RewriteSourcesHook;
  handleRecoverableError: (error: unknown) => void;
  sentryHub: Hub;
  sentryClient: NodeClient;
  deleteFilesAfterUpload?: string | string[];
  sentryCliOptions: {
    url: string;
    authToken: string;
    org: string;
    project: string;
    vcsRemote: string;
    silent: boolean;
    headers?: Record<string, string>;
  };
}

export function createDebugIdUploadFunction({
  assets,
  ignore,
  logger,
  releaseName,
  dist,
  handleRecoverableError,
  sentryHub,
  sentryClient,
  sentryCliOptions,
  rewriteSourcesHook,
  deleteFilesAfterUpload,
}: DebugIdUploadPluginOptions) {
  return async (buildArtifactPaths: string[]) => {
    let folderToCleanUp: string | undefined;

    const cliInstance = new SentryCli(null, sentryCliOptions);

    try {
      const tmpUploadFolder = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "sentry-bundler-plugin-upload-")
      );

      folderToCleanUp = tmpUploadFolder;

      let globAssets;
      if (assets) {
        globAssets = assets;
      } else {
        logger.debug(
          "No `sourcemaps.assets` option provided, falling back to uploading detected build artifacts."
        );
        globAssets = buildArtifactPaths;
      }

      const debugIdChunkFilePaths = (
        await glob(globAssets, {
          absolute: true,
          nodir: true,
          ignore: ignore,
        })
      ).filter(
        (debugIdChunkFilePath) =>
          debugIdChunkFilePath.endsWith(".js") ||
          debugIdChunkFilePath.endsWith(".mjs") ||
          debugIdChunkFilePath.endsWith(".cjs")
      );

      if (Array.isArray(assets) && assets.length === 0) {
        logger.debug(
          "Empty `sourcemaps.assets` option provided. Will not upload sourcemaps with debug ID."
        );
      } else if (debugIdChunkFilePaths.length === 0) {
        logger.warn(
          "Didn't find any matching sources for debug ID upload. Please check the `sourcemaps.assets` option."
        );
      } else {
        await Promise.all(
          debugIdChunkFilePaths.map(async (chunkFilePath, chunkIndex): Promise<void> => {
            await prepareBundleForDebugIdUpload(
              chunkFilePath,
              tmpUploadFolder,
              chunkIndex,
              logger,
              rewriteSourcesHook ?? defaultRewriteSourcesHook
            );
          })
        );

        await cliInstance.releases.uploadSourceMaps(
          releaseName ?? "undefined", // unfortunetly this needs a value for now but it will not matter since debug IDs overpower releases anyhow
          {
            include: [
              {
                paths: [tmpUploadFolder],
                rewrite: false,
                dist: dist,
              },
            ],
            useArtifactBundle: true,
          }
        );
      }

      if (deleteFilesAfterUpload) {
        const filePathsToDelete = await glob(deleteFilesAfterUpload, {
          absolute: true,
          nodir: true,
        });

        filePathsToDelete.forEach((filePathToDelete) => {
          logger.debug(`Deleting asset after upload: ${filePathToDelete}`);
        });

        await Promise.all(
          filePathsToDelete.map((filePathToDelete) =>
            fs.promises.rm(filePathToDelete, { force: true })
          )
        );
      }
    } catch (e) {
      sentryHub.captureException('Error in "debugIdUploadPlugin" writeBundle hook');
      await sentryClient.flush();
      handleRecoverableError(e);
    } finally {
      if (folderToCleanUp) {
        void fs.promises.rm(folderToCleanUp, { recursive: true, force: true });
      }
    }
  };
}

export async function prepareBundleForDebugIdUpload(
  bundleFilePath: string,
  uploadFolder: string,
  chunkIndex: number,
  logger: Logger,
  rewriteSourcesHook: RewriteSourcesHook
) {
  let bundleContent;
  try {
    bundleContent = await promisify(fs.readFile)(bundleFilePath, "utf8");
  } catch (e) {
    logger.error(
      `Could not read bundle to determine debug ID and source map: ${bundleFilePath}`,
      e
    );
    return;
  }

  const debugId = determineDebugIdFromBundleSource(bundleContent);
  if (debugId === undefined) {
    logger.debug(
      `Could not determine debug ID from bundle. This can happen if you did not clean your output folder before installing the Sentry plugin. File will not be source mapped: ${bundleFilePath}`
    );
    return;
  }

  const uniqueUploadName = `${debugId}-${chunkIndex}`;

  bundleContent += `\n//# debugId=${debugId}`;
  const writeSourceFilePromise = fs.promises.writeFile(
    path.join(uploadFolder, `${uniqueUploadName}.js`),
    bundleContent,
    "utf-8"
  );

  const writeSourceMapFilePromise = determineSourceMapPathFromBundle(
    bundleFilePath,
    bundleContent,
    logger
  ).then(async (sourceMapPath): Promise<void> => {
    if (sourceMapPath) {
      return await prepareSourceMapForDebugIdUpload(
        sourceMapPath,
        path.join(uploadFolder, `${uniqueUploadName}.js.map`),
        debugId,
        rewriteSourcesHook,
        logger
      );
    }
  });

  return Promise.all([writeSourceFilePromise, writeSourceMapFilePromise]);
}

/**
 * Looks for a particular string pattern (`sdbid-[debug ID]`) in the bundle
 * source and extracts the bundle's debug ID from it.
 *
 * The string pattern is injected via the debug ID injection snipped.
 */
function determineDebugIdFromBundleSource(code: string): string | undefined {
  const match = code.match(
    /sentry-dbid-([0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12})/
  );

  if (match) {
    return match[1];
  } else {
    return undefined;
  }
}

/**
 * Applies a set of heuristics to find the source map for a particular bundle.
 *
 * @returns the path to the bundle's source map or `undefined` if none could be found.
 */
async function determineSourceMapPathFromBundle(
  bundlePath: string,
  bundleSource: string,
  logger: Logger
): Promise<string | undefined> {
  // 1. try to find source map at `sourceMappingURL` location
  const sourceMappingUrlMatch = bundleSource.match(/^\/\/# sourceMappingURL=(.*)$/);
  if (sourceMappingUrlMatch) {
    const sourceMappingUrl = path.normalize(sourceMappingUrlMatch[1] as string);
    if (path.isAbsolute(sourceMappingUrl)) {
      return sourceMappingUrl;
    } else {
      return path.join(path.dirname(bundlePath), sourceMappingUrl);
    }
  }

  // 2. try to find source map at path adjacent to chunk source, but with `.map` appended
  try {
    const adjacentSourceMapFilePath = bundlePath + ".map";
    await util.promisify(fs.access)(adjacentSourceMapFilePath);
    return adjacentSourceMapFilePath;
  } catch (e) {
    // noop
  }

  // This is just a debug message because it can be quite spammy for some frameworks
  logger.debug(
    `Could not determine source map path for bundle: ${bundlePath} - Did you turn on source map generation in your bundler?`
  );
  return undefined;
}

/**
 * Reads a source map, injects debug ID fields, and writes the source map to the target path.
 */
async function prepareSourceMapForDebugIdUpload(
  sourceMapPath: string,
  targetPath: string,
  debugId: string,
  rewriteSourcesHook: RewriteSourcesHook,
  logger: Logger
): Promise<void> {
  let sourceMapFileContent: string;
  try {
    sourceMapFileContent = await util.promisify(fs.readFile)(sourceMapPath, {
      encoding: "utf8",
    });
  } catch (e) {
    logger.error(`Failed to read source map for debug ID upload: ${sourceMapPath}`, e);
    return;
  }

  let map: Record<string, unknown>;
  try {
    map = JSON.parse(sourceMapFileContent) as { sources: unknown; [key: string]: unknown };
    // For now we write both fields until we know what will become the standard - if ever.
    map["debug_id"] = debugId;
    map["debugId"] = debugId;
  } catch (e) {
    logger.error(`Failed to parse source map for debug ID upload: ${sourceMapPath}`);
    return;
  }

  if (map["sources"] && Array.isArray(map["sources"])) {
    map["sources"].map((source: string) => rewriteSourcesHook(source, map));
  }

  try {
    await util.promisify(fs.writeFile)(targetPath, JSON.stringify(map), {
      encoding: "utf8",
    });
  } catch (e) {
    logger.error(`Failed to prepare source map for debug ID upload: ${sourceMapPath}`, e);
    return;
  }
}

const PROTOCOL_REGEX = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//;
function defaultRewriteSourcesHook(source: string): string {
  if (source.match(PROTOCOL_REGEX)) {
    return source.replace(PROTOCOL_REGEX, "");
  } else {
    return path.relative(process.cwd(), path.normalize(source));
  }
}