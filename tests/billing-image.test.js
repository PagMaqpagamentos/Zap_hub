import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { normalizeBillingImage } from "../src/billing-image.js";
for (const [width,height] of [[3000,1500],[1000,3000],[120,80]]) {
  test(`normaliza imagem ${width}x${height} sem cortar ou ampliar`, async () => {
    const source = await sharp({create:{width,height,channels:4,background:{r:20,g:80,b:140,alpha:0.5}}}).png().toBuffer();
    const result = await normalizeBillingImage("data:image/png;base64,"+source.toString("base64"));
    const output = Buffer.from(result.split(",")[1],"base64");
    const meta = await sharp(output).metadata();
    assert.equal(meta.format,"jpeg");
    assert.ok(meta.width <= 1280 && meta.height <= 1280);
    assert.ok(meta.width <= width && meta.height <= height);
    assert.ok(Math.abs(meta.width/meta.height-width/height) < 0.01);
    assert.ok(output.length <= 500*1024);
  });
}
test("rejeita imagem corrompida e permite remover imagem", async () => {
  assert.equal(await normalizeBillingImage(""), "");
  await assert.rejects(normalizeBillingImage("data:image/png;base64,iVBORw0KGgo="), /Imagem inválida/);
});
