/**
 * MIME parsing.
 *
 * The parser is hand-written, so these tests carry the weight an npm package's
 * own test suite would have carried. They are built out of real message shapes:
 * a Gmail forward with a PDF attached, a marketplace's HTML-only receipt, a
 * message forwarded as an attachment, quoted-printable bodies, folded headers,
 * encoded subjects. What breaks here is a receipt that silently fails to file.
 */

import { suite, check } from './harness.mjs';
import {
  parseEmail, parseHeaders, headerValue, parseContentType, splitHead, splitParts,
  decodeQuotedPrintable, decodeBase64, decodeWords, parseAddress, htmlToText,
  binaryFrom, bytesFrom, textFrom,
} from '../mime.js';

/** Messages are CRLF on the wire. Written with \n here and converted. */
function wire(text) {
  return text.replace(/\n/g, '\r\n');
}

function base64(text) {
  return Buffer.from(text, 'binary').toString('base64').replace(/(.{76})/g, '$1\r\n');
}

/** Four bytes of PDF, which is all `detect` reads. */
const PDF_BYTES = '%PDF-1.4\nfake invoice bytes\n%%EOF';

export default function run() {
  suite('mime — bytes');

  const roundTrip = bytesFrom(binaryFrom(new Uint8Array([0, 127, 128, 255, 65])));
  check('bytes survive the round trip',
    roundTrip.length === 5 && roundTrip[3] === 255 && roundTrip[2] === 128);
  check('utf-8 text decodes',
    textFrom(binaryFrom(new TextEncoder().encode('Café')), 'utf-8') === 'Café');
  check('latin1 is passed through untouched',
    textFrom(String.fromCharCode(0xe9), 'iso-8859-1') === String.fromCharCode(0xe9));
  check('an unknown charset does not throw',
    typeof textFrom('plain', 'x-made-up-9000') === 'string');

  suite('mime — headers');

  const folded = parseHeaders(wire(
    'Content-Type: multipart/mixed;\n\tboundary="=_NextPart_001"\n' +
    'Subject: Your invoice\n' +
    'X-Junk: ignored'
  ));
  check('a folded header is put back together',
    headerValue(folded, 'content-type') === 'multipart/mixed; boundary="=_NextPart_001"');
  check('names are matched lowercased', headerValue(folded, 'subject') === 'Your invoice');
  check('a missing header is empty, not undefined', headerValue(folded, 'nope') === '');

  const ct = parseContentType('application/pdf; name="August invoice.pdf"; charset=utf-8');
  check('the type comes back bare', ct.type === 'application/pdf');
  check('a quoted parameter is unquoted', ct.params.name === 'August invoice.pdf');
  check('a second parameter is read too', ct.params.charset === 'utf-8');
  check('an empty header parses to nothing', parseContentType('').type === '');

  const split = parseContentType(
    "attachment; filename*0=\"Meta Ads \"; filename*1=\"invoice.pdf\""
  );
  check('an RFC 2231 split filename is rejoined',
    split.params.filename === 'Meta Ads invoice.pdf');

  const extended = parseContentType("attachment; filename*=utf-8''Caf%C3%A9%20receipt.pdf");
  check('an RFC 2231 encoded filename is decoded',
    extended.params.filename === 'Café receipt.pdf');

  check('a subject encoded base64 is read',
    decodeWords('=?utf-8?B?Q2Fmw6kgcmVjZWlwdA==?=') === 'Café receipt');
  check('a subject encoded quoted-printable is read',
    decodeWords('=?utf-8?Q?Your_receipt_from_Caf=C3=A9?=') === 'Your receipt from Café');
  check('adjacent encoded words join without the separator',
    decodeWords('=?utf-8?Q?Tandy_?= =?utf-8?Q?Leather?=') === 'Tandy Leather');
  check('plain text is left alone', decodeWords('Order #4417') === 'Order #4417');
  check('a malformed encoded word is left as it stands',
    decodeWords('=?utf-8?B?!!!not base64!!!?=').includes('=?utf-8?B?'));

  const addr = parseAddress('"Tandy Leather" <Orders@Tandy.com>');
  check('a display name is split off', addr.name === 'Tandy Leather');
  check('the address is lowercased', addr.address === 'orders@tandy.com');
  check('a bare address still parses',
    parseAddress('rob@example.com').address === 'rob@example.com');

  suite('mime — decoding');

  check('quoted-printable decodes',
    decodeQuotedPrintable('Total: =2441.20') === 'Total: $41.20');
  check('a soft line break disappears',
    decodeQuotedPrintable('Rawhide City=\r\n Leather') === 'Rawhide City Leather');
  check('base64 decodes', decodeBase64(base64('hello')) === 'hello');
  check('base64 with wrapping newlines decodes',
    decodeBase64('aGVsbG8=\r\n') === 'hello');
  check('unparseable base64 comes back empty, not thrown',
    decodeBase64('!!!!') === '');

  suite('mime — parts');

  const parts = splitParts(wire(
    'preamble nobody reads\n' +
    '--BOUND\nfirst\n' +
    '--BOUND\nsecond\n' +
    '--BOUND--\nepilogue nobody reads'
  ), 'BOUND');
  check('every part is found', parts.length === 2);
  check('the preamble is not a part', !parts[0].includes('preamble'));
  check('the epilogue is not a part', !parts[1].includes('epilogue'));
  check('the part body survives', parts[0].trim() === 'first' && parts[1].trim() === 'second');

  // A boundary that is a prefix of a longer one. Real senders do this: outer
  // "=_Part_1" wrapping inner "=_Part_12".
  const prefixed = splitParts(wire('--B\nouter\n--B12\nnot a boundary\n--B--'), 'B');
  check('a longer boundary is not mistaken for this one',
    prefixed.length === 1 && prefixed[0].includes('not a boundary'));

  const head = splitHead(wire('Subject: hi\n\nthe body'));
  check('the header block ends at the blank line', head.head === 'Subject: hi');
  check('and the body starts after it', head.body === 'the body');
  check('a message with no body does not lose its headers',
    splitHead('Subject: hi').head === 'Subject: hi');

  suite('mime — a forwarded receipt');

  const forwarded = parseEmail(wire(
    'From: Rob <rawhidecityleather@gmail.com>\n' +
    'To: receipts@rawhidecityleather.com\n' +
    'Subject: =?utf-8?Q?Fwd=3A_Your_Tandy_order?=\n' +
    'Date: Tue, 18 Aug 2026 09:12:03 -0400\n' +
    'Content-Type: multipart/mixed; boundary="OUTER"\n' +
    '\n' +
    '--OUTER\n' +
    'Content-Type: multipart/alternative; boundary="INNER"\n' +
    '\n' +
    '--INNER\n' +
    'Content-Type: text/plain; charset="utf-8"\n' +
    'Content-Transfer-Encoding: quoted-printable\n' +
    '\n' +
    'Forwarded. Total was =2441.20.\n' +
    '--INNER\n' +
    'Content-Type: text/html; charset="utf-8"\n' +
    '\n' +
    '<p>Forwarded. Total was $41.20.</p>\n' +
    '--INNER--\n' +
    '--OUTER\n' +
    'Content-Type: application/pdf; name="invoice.pdf"\n' +
    'Content-Disposition: attachment; filename="invoice.pdf"\n' +
    'Content-Transfer-Encoding: base64\n' +
    '\n' + base64(PDF_BYTES) + '\n' +
    '--OUTER--'
  ));

  check('the sender is read', forwarded.from === 'rawhidecityleather@gmail.com');
  check('the display name is read', forwarded.fromName === 'Rob');
  check('the encoded subject is decoded', forwarded.subject === 'Fwd: Your Tandy order');
  check('the date header is kept', forwarded.date.startsWith('Tue, 18 Aug 2026'));
  check('the quoted-printable text part is decoded',
    forwarded.text === 'Forwarded. Total was $41.20.');
  check('the html part is kept separately', forwarded.html.includes('<p>'));
  check('the nested tree yields exactly one attachment', forwarded.attachments.length === 1);
  check('the attachment keeps its filename', forwarded.attachments[0].name === 'invoice.pdf');
  check('the attachment bytes are the decoded PDF',
    String.fromCharCode(...forwarded.attachments[0].bytes.subarray(0, 4)) === '%PDF');
  check('the attachment is not flagged inline', forwarded.attachments[0].inline === false);

  suite('mime — the awkward shapes');

  const htmlOnly = parseEmail(wire(
    'From: billing@meta.com\n' +
    'Subject: Your Meta ads receipt\n' +
    'Content-Type: text/html; charset="utf-8"\n' +
    '\n' +
    '<html><body><table><tr><td>Total</td><td>$114.02</td></tr></table></body></html>'
  ));
  check('an html-only receipt has no attachments', htmlOnly.attachments.length === 0);
  check('and its html is captured', htmlOnly.html.includes('114.02'));
  check('flattened, the total is still findable',
    htmlToText(htmlOnly.html).includes('Total $114.02'));

  const plain = parseEmail(wire('From: a@b.com\nSubject: hi\n\njust text'));
  check('a message with no MIME parts still yields its body', plain.text === 'just text');

  const attached = parseEmail(wire(
    'From: Rob <rawhidecityleather@gmail.com>\n' +
    'Subject: Fwd: receipt\n' +
    'Content-Type: multipart/mixed; boundary="M"\n' +
    '\n' +
    '--M\n' +
    'Content-Type: text/plain\n' +
    '\n' +
    'see attached\n' +
    '--M\n' +
    'Content-Type: message/rfc822\n' +
    '\n' +
    'From: orders@uline.com\n' +
    'Subject: Uline order 88213\n' +
    'Content-Type: text/plain\n' +
    '\n' +
    'Order total: $212.44\n' +
    '--M--'
  ));
  check('a message forwarded as an attachment is opened',
    attached.text.includes('Order total: $212.44'));
  check('and the outer note is kept too', attached.text.includes('see attached'));

  const inline = parseEmail(wire(
    'From: a@b.com\n' +
    'Content-Type: multipart/related; boundary="R"\n' +
    '\n' +
    '--R\n' +
    'Content-Type: image/png\n' +
    'Content-ID: <logo>\n' +
    'Content-Disposition: inline\n' +
    'Content-Transfer-Encoding: base64\n' +
    '\n' + base64('\x89PNG\r\n\x1a\nlogo bytes') + '\n' +
    '--R--'
  ));
  check('a signature image is flagged inline', inline.attachments[0]?.inline === true);

  check('garbage does not throw', () => {
    const junk = parseEmail('\x00\x01\x02 not an email at all');
    return junk.attachments.length === 0 && typeof junk.text === 'string';
  });
  check('an empty message does not throw', () => parseEmail('').subject === '');

  suite('mime — html to text');

  check('a script block is dropped',
    !htmlToText('<script>var a=1</script><p>Total $9</p>').includes('var a'));
  check('a comment is dropped', !htmlToText('<!-- hide --><p>x</p>').includes('hide'));
  check('a break becomes a newline', htmlToText('a<br>b') === 'a\nb');
  check('cells do not run together', htmlToText('<td>Tax</td><td>$2.10</td>') === 'Tax $2.10');
  check('named entities decode', htmlToText('AT&amp;T &mdash; $5&nbsp;each') === 'AT&T - $5 each');
  check('numeric entities decode as printed',
    htmlToText('Total &#8212; $5.00 &#x2014; paid') === 'Total — $5.00 — paid');
  check('an entity we do not know is left alone',
    htmlToText('100&deg; in the shop') === '100&deg; in the shop');
  check('runs of blank lines collapse', htmlToText('<p>a</p><p></p><p>b</p>') === 'a\nb');
  check('nothing in, nothing out', htmlToText('') === '');
}
