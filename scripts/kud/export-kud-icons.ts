#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Build-time asset export run directly by Node.
// Renders every Kud Code PNG/ICO icon from the SVG sources in assets/kud/.
// Run from the repo root: node scripts/kud/export-kud-icons.ts

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import sharp from "sharp";

import { encodePngIco, WINDOWS_ICON_SIZES } from "../lib/icon-export.ts";

const assetsDir = NodePath.resolve(import.meta.dirname, "../../assets/kud");
const SMALL_ICON_MAX_SIZE = 32;

const appIconSvg = await NodeFSP.readFile(NodePath.join(assetsDir, "kud-app-icon.svg"), "utf8");
const smallIconSvg = await NodeFSP.readFile(NodePath.join(assetsDir, "kud-icon-small.svg"), "utf8");

// Full-bleed variants crop the 1024 grid to the 824px body (dropping the shadow margin).
const universalSvg = appIconSvg.replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"');
// Square variant (apple-touch): iOS masks the corners itself, so the body must be opaque to the edge.
const squareSvg = universalSvg.replaceAll('rx="185"', 'rx="0"');

// Rasterise at the target size (density is relative to the SVG's own width) so edges stay crisp.
const render = (svg: string, size: number): Promise<Buffer> =>
  sharp(Buffer.from(svg), { density: (72 * size) / Number(/width="(\d+)"/.exec(svg)?.[1] ?? size) })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

const renderIcon = (size: number): Promise<Buffer> =>
  render(size <= SMALL_ICON_MAX_SIZE ? smallIconSvg : universalSvg, size);

const outputs: ReadonlyArray<readonly [string, Promise<Buffer>]> = [
  ["kud-macos-1024.png", render(appIconSvg, 1024)],
  ["kud-universal-1024.png", render(universalSvg, 1024)],
  ["kud-web-favicon-16x16.png", renderIcon(16)],
  ["kud-web-favicon-32x32.png", renderIcon(32)],
  ["kud-web-apple-touch-180.png", render(squareSvg, 180)],
  ["kud-web-icon-192x192.png", renderIcon(192)],
  ["kud-web-icon-512x512.png", renderIcon(512)],
];

for (const [name, contents] of outputs) {
  await NodeFSP.writeFile(NodePath.join(assetsDir, name), await contents);
  console.log(`wrote assets/kud/${name}`);
}

const icoImages = async (sizes: ReadonlyArray<number>) =>
  Promise.all(sizes.map(async (size) => ({ size, contents: await renderIcon(size) })));

await NodeFSP.writeFile(
  NodePath.join(assetsDir, "kud-windows.ico"),
  encodePngIco(await icoImages(WINDOWS_ICON_SIZES)),
);
console.log("wrote assets/kud/kud-windows.ico");
await NodeFSP.writeFile(
  NodePath.join(assetsDir, "kud-web-favicon.ico"),
  encodePngIco(await icoImages([16, 32, 48])),
);
console.log("wrote assets/kud/kud-web-favicon.ico");
