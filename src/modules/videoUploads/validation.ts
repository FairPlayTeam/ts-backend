// XML 1.0 Char: https://www.w3.org/TR/xml/#charsets
// Check the original string before trimming or UTF-8 encoding can discard invalid input.
const XML_COMPATIBLE_CHARACTERS = /^[\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u;

export const isXmlCompatibleUploadETag = (etag: string): boolean =>
  XML_COMPATIBLE_CHARACTERS.test(etag);
