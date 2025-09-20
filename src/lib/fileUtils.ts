import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export const generateSecureFilename = (originalName: string): string => {
  const extension = path.extname(originalName).toLowerCase();

  const secureName = `${uuidv4()}${extension}`;

  return secureName;
};
