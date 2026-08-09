/**
 * Uploaded background-image catalog (see PlacedImage in types.ts). Unlike
 * furniture/floor/wall, there are no bundled defaults here — every entry is
 * user-uploaded, id-keyed like furniture (see server/src/assetOverrides.ts's
 * 'image' asset type).
 */
export interface ImageAsset {
  id: string;
  label: string;
  /** A `data:image/png;base64,...` data URL — ready to feed directly into an
   *  `<img>` tag or Phaser's texture loader, no further decoding needed. */
  data: string;
  /** Natural pixel dimensions, for a sane default footprint when placing. */
  width: number;
  height: number;
}

let imageAssets: ImageAsset[] = [];

export function setImageAssets(list: ImageAsset[]): void {
  imageAssets = list;
}

export function getImageAssetList(): ImageAsset[] {
  return imageAssets;
}

export function getImageAsset(id: string): ImageAsset | undefined {
  return imageAssets.find((a) => a.id === id);
}
