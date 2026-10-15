import type { H3Event } from 'h3';
import type { Hidden } from './hidden.js';
/** A doc comment that must not reach the report. */
export declare function greet(name: string): string;
export declare function greet(name: string, loud: boolean): string;
export declare const LIMIT: number;
export declare class Box {
    value: Hidden;
    constructor(value: Hidden);
}
export interface Options extends Base {
    // A line comment that must not reach the report.
    event: H3Event;
    tree: Tree;
    mode?: Mode;
}
export type Mode = 'a' | 'b';
export { renamed as alias } from './other.js';
declare const config: {
    mode: Mode;
};
export default config;
interface Tree {
    children: Tree[];
    leaf: Leaf;
}
interface Leaf {
    parent: Tree;
}
interface Base {
    id: string;
}
