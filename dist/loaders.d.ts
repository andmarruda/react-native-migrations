export interface SqlLoaderInput {
    directory: string;
    path: string;
}
export declare function createStaticSqlLoader(files: Record<string, string>): ({ directory, path }: SqlLoaderInput) => Promise<string>;
export declare function createAssetSqlLoader(assets: Record<string, string>, readAsset: (assetReference: string) => Promise<string>): ({ directory, path }: SqlLoaderInput) => Promise<string>;
