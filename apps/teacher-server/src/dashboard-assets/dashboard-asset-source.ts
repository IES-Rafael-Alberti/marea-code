export interface DashboardAsset {
  readonly body: Blob;
  readonly contentType: string;
  readonly entityTag: string;
  readonly immutable: boolean;
}

export interface DashboardAssetSource {
  readonly find: (assetPath: string) => DashboardAsset | null;
}
