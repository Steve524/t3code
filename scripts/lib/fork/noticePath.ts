// License manifests use portable labels, even when collected on Windows.
export const noticePath = (path: string) => path.replaceAll("\\", "/");
