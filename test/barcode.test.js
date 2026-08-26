import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import bwipjs from 'bwip-js';

import { decodeBarcode } from '../lib/barcode.js';

describe('barcode decoding (library, no AI)', () => {
  test('a generated EAN-13 round-trips through the decoder', async () => {
    const png = await bwipjs.toBuffer({
      bcid: 'ean13', text: '7290004131074', scale: 3, height: 15,
      includetext: true, backgroundcolor: 'FFFFFF', paddingwidth: 12, paddingheight: 8,
    });
    assert.equal(await decodeBarcode(png), '7290004131074');
  });

  test('a non-barcode image returns null, never throws', async () => {
    assert.equal(await decodeBarcode(Buffer.from('not an image at all')), null);
  });
});
