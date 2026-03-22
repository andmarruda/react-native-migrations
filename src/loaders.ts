export interface SqlLoaderInput {
  directory: string;
  path: string;
}

export function createStaticSqlLoader(files: Record<string, string>) {
  return async ({ directory, path }: SqlLoaderInput) => {
    const key = `${directory}/${path}`;
    const sql = files[key];

    if (typeof sql !== "string") {
      throw new Error(`SQL file "${key}" was not found in the provided static loader map.`);
    }

    return sql;
  };
}

export function createAssetSqlLoader(
  assets: Record<string, string>,
  readAsset: (assetReference: string) => Promise<string>,
) {
  return async ({ directory, path }: SqlLoaderInput) => {
    const key = `${directory}/${path}`;
    const assetReference = assets[key];

    if (!assetReference) {
      throw new Error(`SQL asset "${key}" was not found in the provided asset map.`);
    }

    return readAsset(assetReference);
  };
}
