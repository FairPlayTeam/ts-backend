const appendQueryParam = (
  uri: string,
  key: string,
  value: string,
): string => {
  const [beforeHash, hash = ''] = uri.split('#', 2);
  const separator = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash ? `#${hash}` : ''}`;
};

export const rewritePlaylistWithToken = (
  playlist: string,
  token: string,
): string =>
  playlist
    .split(/\r?\n/)
    .map((line) => {
      const trimmedLine = line.trim();

      if (trimmedLine.length === 0 || trimmedLine.startsWith('#')) {
        return line;
      }

      return appendQueryParam(trimmedLine, 'token', token);
    })
    .join('\n');
