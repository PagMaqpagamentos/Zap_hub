export async function prepareBillingImage(file) {
  if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 20 * 1024 * 1024)
    throw new Error("Escolha um PNG ou JPEG de até 20 MB. A imagem será reduzida automaticamente.");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40000000)
      throw new Error("A imagem excede 40 megapixels. Escolha uma imagem menor.");
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.75, 0.65, 0.5]) {
      const value = canvas.toDataURL("image/jpeg", quality);
      if ((value.length - value.indexOf(",") - 1) * 0.75 <= 500 * 1024) return value;
    }
    throw new Error("Não foi possível reduzir a imagem. Escolha uma imagem mais simples.");
  } catch (error) {
    throw new Error(error.message || "Não foi possível abrir a imagem.");
  } finally { bitmap?.close(); }
}
