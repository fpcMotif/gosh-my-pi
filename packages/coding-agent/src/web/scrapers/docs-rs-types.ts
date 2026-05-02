/**
 * Rustdoc JSON type definitions for the docs.rs scraper.
 */

export interface RustdocCrate {
	root: number;
	crate_version: string | null;
	index: Record<string, RustdocItem>;
	paths: Record<string, { crate_id: number; path: string[]; kind: string }>;
	format_version: number;
}

export interface RustdocItem {
	name: string | null;
	docs: string | null;
	attrs: string[];
	inner: Record<string, unknown>;
	visibility: string | { restricted: { parent: number; path: string } };
	deprecation: { since: string | null; note: string | null } | null;
}

export interface FunctionData {
	sig: { inputs: [string, RustType][]; output: RustType | null };
	generics: Generics;
	has_body: boolean;
	is_async: boolean;
	is_unsafe: boolean;
	is_const: boolean;
}

export interface Generics {
	params: GenericParam[];
	where_predicates: unknown[];
}

export interface GenericParam {
	name: string;
	kind: Record<string, unknown>;
}

export type RustType = Record<string, unknown>;

export interface DocsRsTarget {
	crateName: string;
	version: string;
	modulePath: string[];
	itemKind: string | null;
	itemName: string | null;
}

export interface RustdocImplData {
	trait?: { path: string; args?: { angle_bracketed?: { args: unknown[] } } } | null;
	items: number[];
	is_synthetic?: boolean;
	blanket_impl?: RustType | null;
}
