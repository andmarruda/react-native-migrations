"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStaticSqlLoader = createStaticSqlLoader;
exports.createAssetSqlLoader = createAssetSqlLoader;
function createStaticSqlLoader(files) {
    return async ({ directory, path }) => {
        const key = `${directory}/${path}`;
        const sql = files[key];
        if (typeof sql !== "string") {
            throw new Error(`SQL file "${key}" was not found in the provided static loader map.`);
        }
        return sql;
    };
}
function createAssetSqlLoader(assets, readAsset) {
    return async ({ directory, path }) => {
        const key = `${directory}/${path}`;
        const assetReference = assets[key];
        if (!assetReference) {
            throw new Error(`SQL asset "${key}" was not found in the provided asset map.`);
        }
        return readAsset(assetReference);
    };
}
