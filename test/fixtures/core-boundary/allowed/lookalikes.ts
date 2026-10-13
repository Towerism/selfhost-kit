import { x } from 'h3-utils';
import { y } from './h3.js';
import type { Z } from 'nuxtlike';
import { readFile } from 'node:fs/promises';

// A string that merely mentions 'h3' is not an import.
export const note = "import { createApp } from 'h3'";
export { x, y, readFile };
export type { Z };
