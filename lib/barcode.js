// Barcode decoding in code — no AI. ZXing (WASM) reads EAN/UPC straight from
// the photo bytes Telegram gives us. A miss returns null and the caller falls
// back to asking for a sharper photo or typed digits.

import { readBarcodes } from 'zxing-wasm/reader';

export async function decodeBarcode(imageBuffer) {
  try {
    const results = await readBarcodes(new Blob([imageBuffer]), {
      formats: ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E'],
      tryHarder: true,
      maxNumberOfSymbols: 1,
    });
    const hit = (results || []).find((r) => /^\d{8,14}$/.test(r.text || ''));
    return hit ? hit.text : null;
  } catch (err) {
    console.error('barcode decode error:', err.message);
    return null;
  }
}
