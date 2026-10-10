import sharp from "sharp";
export async function normalizeBillingImage(value) {
  if (!value) return "";
  try {
    const source = Buffer.from(value.split(",")[1], "base64");
    const pipeline = sharp(source, { limitInputPixels: 40000000, failOn: "warning" });
    const meta = await pipeline.metadata();
    if (!["png", "jpeg"].includes(meta.format) || (meta.pages || 1) > 1) throw new Error();
    let width = 1280;
    for (let attempt = 0; attempt < 5; attempt++) {
      const output = await pipeline.clone().rotate().resize({ width, height: width, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
      if (output.length <= 500 * 1024) return "data:image/jpeg;base64," + output.toString("base64");
      width = Math.floor(width * 0.75);
    }
  } catch { /* Invalid images must not replace the saved image. */ }
  const error = new Error("Imagem inválida ou grande demais. Escolha outro PNG ou JPEG.");
  error.status = 400;
  throw error;
}
