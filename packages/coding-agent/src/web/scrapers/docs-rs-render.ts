/**
 * Rustdoc JSON rendering helpers split from docs-rs.ts to keep that file under max-lines.
 */
import type {
	DocsRsTarget,
	FunctionData,
	Generics,
	RustdocCrate,
	RustdocImplData,
	RustdocItem,
	RustType,
} from "./docs-rs-types";

export type {
	DocsRsTarget,
	FunctionData,
	Generics,
	GenericParam,
	RustdocCrate,
	RustdocImplData,
	RustdocItem,
	RustType,
} from "./docs-rs-types";

// --- Type rendering ---

function renderResolvedPath(
	rp: { path: string; args?: { angle_bracketed?: { args: unknown[] } } },
	depth: number,
): string {
	const args = rp.args?.angle_bracketed?.args;
	if (args === undefined || args.length === 0) return rp.path;
	const rendered = args
		.map((a: unknown) => {
			if (typeof a === "object" && a !== null && "type" in a)
				return renderType((a as { type: RustType }).type, depth + 1);
			if (typeof a === "object" && a !== null && "lifetime" in a) return `'${(a as { lifetime: string }).lifetime}`;
			return "_";
		})
		.join(", ");
	return `${rp.path}<${rendered}>`;
}

function renderBorrowedRef(
	br: { lifetime: string | null; is_mutable: boolean; type: RustType },
	depth: number,
): string {
	const lt = br.lifetime !== null && br.lifetime !== "" ? `'${br.lifetime} ` : "";
	const mutStr = br.is_mutable ? "mut " : "";
	return `&${lt}${mutStr}${renderType(br.type, depth + 1)}`;
}

function renderQualifiedPath(
	qp: { name: string; self_type: RustType; trait_: RustType | null },
	depth: number,
): string {
	const self_ = renderType(qp.self_type, depth + 1);
	if (qp.trait_) return `<${self_} as ${renderType(qp.trait_, depth + 1)}>::${qp.name}`;
	return `${self_}::${qp.name}`;
}

function renderImplTraitInline(bounds: Array<{ trait_bound?: { trait: RustType } }>, depth: number): string {
	const parts = bounds
		.map(b => (b.trait_bound ? renderType(b.trait_bound.trait as RustType, depth + 1) : "?"))
		.join(" + ");
	return `impl ${parts}`;
}

function renderDynTrait(dt: { traits: Array<{ trait: RustType }>; lifetime: string | null }, depth: number): string {
	const parts = dt.traits.map(t => renderType(t.trait as RustType, depth + 1)).join(" + ");
	const lt = dt.lifetime !== null && dt.lifetime !== "" ? ` + '${dt.lifetime}` : "";
	return `dyn ${parts}${lt}`;
}

function renderTuple(items: RustType[], depth: number): string {
	const rendered = items.map(t => renderType(t, depth + 1));
	return `(${rendered.join(", ")})`;
}

function renderArray(arr: { type: RustType; len: string }, depth: number): string {
	return `[${renderType(arr.type, depth + 1)}; ${arr.len}]`;
}

function renderRawPointer(rp: { is_mutable: boolean; type: RustType }, depth: number): string {
	return `*${rp.is_mutable ? "mut" : "const"} ${renderType(rp.type, depth + 1)}`;
}

const SIMPLE_TYPE_KEYS: Record<string, (ty: RustType, depth: number) => string> = {
	generic: ty => ty.generic as string,
	primitive: ty => ty.primitive as string,
	infer: () => "_",
	resolved_path: (ty, depth) =>
		renderResolvedPath(ty.resolved_path as { path: string; args?: { angle_bracketed?: { args: unknown[] } } }, depth),
	borrowed_ref: (ty, depth) =>
		renderBorrowedRef(ty.borrowed_ref as { lifetime: string | null; is_mutable: boolean; type: RustType }, depth),
	tuple: (ty, depth) => renderTuple(ty.tuple as RustType[], depth),
	slice: (ty, depth) => `[${renderType(ty.slice as RustType, depth + 1)}]`,
	array: (ty, depth) => renderArray(ty.array as { type: RustType; len: string }, depth),
	raw_pointer: (ty, depth) => renderRawPointer(ty.raw_pointer as { is_mutable: boolean; type: RustType }, depth),
	qualified_path: (ty, depth) =>
		renderQualifiedPath(ty.qualified_path as { name: string; self_type: RustType; trait_: RustType | null }, depth),
	impl_trait: (ty, depth) =>
		renderImplTraitInline(ty.impl_trait as Array<{ trait_bound?: { trait: RustType } }>, depth),
	dyn_trait: (ty, depth) =>
		renderDynTrait(ty.dyn_trait as { traits: Array<{ trait: RustType }>; lifetime: string | null }, depth),
	function_pointer: () => "fn(...)",
};

export function renderType(ty: RustType | null | undefined, depth = 0): string {
	if (!ty || depth > 10) return "_";
	if (typeof ty === "string") return ty;
	for (const [key, render] of Object.entries(SIMPLE_TYPE_KEYS)) {
		if (key in ty) return render(ty, depth);
	}
	return "_";
}

export function renderGenerics(generics: Generics): string {
	if (generics.params.length === 0) return "";
	const params = generics.params
		.filter(p => Object.keys(p.kind).length > 0 && !("lifetime" in p.kind))
		.map(p => p.name);
	if (params.length === 0) return "";
	return `<${params.join(", ")}>`;
}

export function renderFunctionSig(name: string, fn_: FunctionData, generics?: Generics): string {
	const parts: string[] = [];
	if (fn_.is_const) parts.push("const");
	if (fn_.is_async) parts.push("async");
	if (fn_.is_unsafe) parts.push("unsafe");
	parts.push("fn");
	const gen = generics ? renderGenerics(generics) : renderGenerics(fn_.generics);
	const inputs = fn_.sig.inputs
		.map(([n, ty]) => {
			if (n === "self") return renderType(ty);
			return `${n}: ${renderType(ty)}`;
		})
		.join(", ");
	const output = fn_.sig.output ? ` -> ${renderType(fn_.sig.output)}` : "";
	return `${parts.join(" ")} ${name}${gen}(${inputs})${output}`;
}

const ITEM_DECL_RENDERERS: Record<string, (item: RustdocItem) => string> = {
	function: item => renderFunctionSig(item.name ?? "?", item.inner.function as FunctionData),
	struct: item => {
		const s = item.inner.struct as { generics: Generics; kind: Record<string, unknown> };
		return `struct ${item.name}${renderGenerics(s.generics)}`;
	},
	enum: item => {
		const e = item.inner.enum as { generics: Generics; variants: number[] };
		return `enum ${item.name}${renderGenerics(e.generics)}`;
	},
	trait: item => {
		const t = item.inner.trait as { generics: Generics; is_auto: boolean; is_unsafe: boolean };
		const prefix = t.is_unsafe ? "unsafe " : "";
		return `${prefix}trait ${item.name}${renderGenerics(t.generics)}`;
	},
	type_alias: item => {
		const ta = item.inner.type_alias as { generics: Generics; type: RustType | null };
		const ty = ta.type ? ` = ${renderType(ta.type)}` : "";
		return `type ${item.name}${renderGenerics(ta.generics)}${ty}`;
	},
	macro_def: item => `macro ${item.name}!(...)`,
	constant: item => {
		const c = item.inner.constant as { type: RustType; value: string | null };
		const valuePart = c.value !== null && c.value !== "" ? ` = ${c.value}` : "";
		return `const ${item.name}: ${renderType(c.type)}${valuePart}`;
	},
};

export function renderItemDecl(item: RustdocItem): string | null {
	for (const [key, render] of Object.entries(ITEM_DECL_RENDERERS)) {
		if (key in item.inner) return render(item);
	}
	return null;
}

export function itemKindFromInner(inner: Record<string, unknown>): string {
	return Object.keys(inner)[0] ?? "unknown";
}

export function findItemInModule(
	mod_: RustdocItem,
	name: string,
	index: Record<string, RustdocItem>,
): RustdocItem | null {
	const innerMod = mod_.inner as { module?: { items: number[] } };
	const modData = innerMod.module;
	if (!modData?.items) return null;
	for (const id of modData.items) {
		const item = index[String(id)];
		if (item === undefined) continue;
		if (item.name === name) return item;
		if ("use" in item.inner) {
			const use_ = item.inner.use as { name: string; id: number | null };
			if (use_.name === name && use_.id !== null) {
				const target = index[String(use_.id)];
				if (target !== undefined) return target;
			}
		}
	}
	return null;
}

function renderImplTrait(trait_: NonNullable<RustdocImplData["trait"]>): string {
	return renderType({ resolved_path: { path: trait_.path, args: trait_.args } });
}

function buildMethodLine(method: RustdocItem, sig: string): string {
	const docsPart = method.docs !== null && method.docs !== "" ? ` — ${firstLine(method.docs)}` : "";
	return `- \`${sig}\`${docsPart}`;
}

export function collectInherentMethodLines(implIds: number[], index: Record<string, RustdocItem>): string[] {
	const methods: string[] = [];
	for (const implId of implIds) {
		const impl_ = index[String(implId)];
		if (impl_ === undefined || !("impl" in impl_.inner)) continue;
		const implData = impl_.inner.impl as RustdocImplData;
		if (
			implData.is_synthetic === true ||
			(implData.trait !== null && implData.trait !== undefined) ||
			(implData.blanket_impl !== null && implData.blanket_impl !== undefined)
		)
			continue;
		appendImplMethods(implData, index, methods);
	}
	return methods;
}

function appendImplMethods(implData: RustdocImplData, index: Record<string, RustdocItem>, methods: string[]): void {
	for (const mId of implData.items ?? []) {
		const method = index[String(mId)];
		if (method?.name === null || method?.name === undefined || method?.name === "") continue;
		if (!("function" in method.inner)) continue;
		const fn_ = method.inner.function as FunctionData;
		const sig = renderFunctionSig(method.name, fn_);
		methods.push(buildMethodLine(method, sig));
	}
}

export function collectExplicitTraitImplNames(implIds: number[], index: Record<string, RustdocItem>): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const implId of implIds) {
		const impl_ = index[String(implId)];
		if (impl_ === undefined || !("impl" in impl_.inner)) continue;
		const implData = impl_.inner.impl as RustdocImplData;
		if (
			implData.is_synthetic === true ||
			(implData.blanket_impl !== null && implData.blanket_impl !== undefined) ||
			implData.trait === null ||
			implData.trait === undefined
		)
			continue;
		const name = renderImplTrait(implData.trait);
		if (!seen.has(name)) {
			seen.add(name);
			names.push(name);
		}
	}
	return names;
}

interface TraitItemBuckets {
	required: string[];
	provided: string[];
}

function bucketTraitItems(traitItems: number[], index: Record<string, RustdocItem>): TraitItemBuckets {
	const required: string[] = [];
	const provided: string[] = [];
	for (const id of traitItems) {
		const child = index[String(id)];
		if (child === undefined) continue;
		bucketChildItem(child, required, provided);
	}
	return { required, provided };
}

function bucketChildItem(child: RustdocItem, required: string[], provided: string[]): void {
	if ("function" in child.inner) {
		const fn_ = child.inner.function as FunctionData;
		const sig = renderFunctionSig(child.name ?? "?", fn_);
		const docsPart = child.docs !== null && child.docs !== "" ? ` — ${firstLine(child.docs)}` : "";
		const line = `- \`${sig}\`${docsPart}`;
		if (fn_.has_body) provided.push(line);
		else required.push(line);
	} else if ("assoc_type" in child.inner) {
		const docsPart = child.docs !== null && child.docs !== "" ? ` — ${firstLine(child.docs)}` : "";
		required.push(`- \`type ${child.name}\`${docsPart}`);
	}
}

function renderItemHeader(item: RustdocItem, kind: string): string {
	let md = `# ${kind} ${item.name}\n\n`;
	if (item.deprecation) {
		const note = item.deprecation.note !== null && item.deprecation.note !== "" ? `: ${item.deprecation.note}` : "";
		md += `> **Deprecated**${note}\n\n`;
	}
	const decl = renderItemDecl(item);
	if (decl !== null && decl !== "") md += `\`\`\`rust\n${decl}\n\`\`\`\n\n`;
	if (item.docs !== null && item.docs !== "") md += `${item.docs}\n\n`;
	return md;
}

function renderTraitItemsSections(traitItems: number[], index: Record<string, RustdocItem>): string {
	if (traitItems.length === 0) return "";
	const buckets = bucketTraitItems(traitItems, index);
	let md = "";
	if (buckets.required.length > 0) md += `## Required Methods\n\n${buckets.required.join("\n")}\n\n`;
	if (buckets.provided.length > 0) md += `## Provided Methods\n\n${buckets.provided.join("\n")}\n\n`;
	return md;
}

function renderImplsSections(impls: number[], index: Record<string, RustdocItem>): string {
	let md = "";
	const methods = collectInherentMethodLines(impls, index);
	if (methods.length > 0) md += `## Methods\n\n${methods.join("\n")}\n\n`;
	const traitImpls = collectExplicitTraitImplNames(impls, index);
	if (traitImpls.length > 0) md += `## Trait Implementations\n\n${traitImpls.map(t => `- ${t}`).join("\n")}\n\n`;
	return md;
}

function renderEnumVariants(item: RustdocItem, index: Record<string, RustdocItem>): string {
	const variants = (item.inner.enum as { variants: number[] }).variants ?? [];
	const lines: string[] = [];
	for (const vId of variants) {
		const v = index[String(vId)];
		if (v?.name === null || v?.name === undefined || v?.name === "") continue;
		const docsPart = v.docs !== null && v.docs !== "" ? ` — ${firstLine(v.docs)}` : "";
		lines.push(`- \`${v.name}\`${docsPart}`);
	}
	return lines.length === 0 ? "" : `## Variants\n\n${lines.join("\n")}\n\n`;
}

export function renderSingleItem(item: RustdocItem, index: Record<string, RustdocItem>, crate_: RustdocCrate): string {
	const kind = itemKindFromInner(item.inner);
	let md = renderItemHeader(item, kind);

	if ("struct" in item.inner || "enum" in item.inner || "trait" in item.inner || "union" in item.inner) {
		const innerWithImpls = item.inner[kind] as { impls?: number[]; items?: number[] } | undefined;
		const impls = innerWithImpls?.impls ?? [];
		const traitItems = innerWithImpls?.items ?? [];
		md += renderTraitItemsSections(traitItems, index);
		md += renderImplsSections(impls, index);
	}

	if ("enum" in item.inner) {
		md += renderEnumVariants(item, index);
	}

	if (crate_.crate_version !== null && crate_.crate_version !== "") md += `---\n*${crate_.crate_version}*\n`;
	return md;
}

const KIND_ORDER = ["module", "macro_def", "struct", "enum", "trait", "function", "type_alias", "constant", "static"];
const KIND_LABELS: Record<string, string> = {
	module: "Modules",
	macro_def: "Macros",
	struct: "Structs",
	enum: "Enums",
	trait: "Traits",
	function: "Functions",
	type_alias: "Type Aliases",
	constant: "Constants",
	static: "Statics",
	union: "Unions",
};

interface GroupedItem {
	name: string;
	docs: string;
	decl: string | null;
}

function isHidden(visibility: RustdocItem["visibility"]): boolean {
	if (visibility === "crate") return true;
	if (typeof visibility === "object" && "restricted" in visibility) return true;
	return false;
}

interface ResolvedItem {
	item: RustdocItem;
	displayName: string;
}

function resolveModuleItem(rawItem: RustdocItem, index: Record<string, RustdocItem>): ResolvedItem | null {
	let item = rawItem;
	let displayName = item.name;
	if ("use" in item.inner) {
		const use_ = item.inner.use as { name: string; id: number | null };
		displayName = use_.name;
		if (use_.id === null) return null;
		const resolved = index[String(use_.id)];
		if (resolved === undefined) return null;
		item = resolved;
	}
	if (displayName === null || displayName === "") return null;
	if (isHidden(item.visibility)) return null;
	return { item, displayName };
}

function groupModuleItems(modItems: number[], index: Record<string, RustdocItem>): Record<string, GroupedItem[]> {
	const groups: Record<string, GroupedItem[]> = {};
	for (const id of modItems) {
		const rawItem = index[String(id)];
		if (rawItem === undefined) continue;
		const resolved = resolveModuleItem(rawItem, index);
		if (resolved === null) continue;
		const kind = itemKindFromInner(resolved.item.inner);
		(groups[kind] ??= []).push({
			name: resolved.displayName,
			docs: firstLine(resolved.item.docs ?? ""),
			decl: renderItemDecl(resolved.item),
		});
	}
	return groups;
}

function renderGroupedItem(item: GroupedItem, kind: string): string {
	if (item.decl !== null && item.decl !== "" && kind === "function") {
		return `- \`${item.decl}\`${item.docs === "" ? "" : ` — ${item.docs}`}\n`;
	}
	return `- **${item.name}**${item.docs === "" ? "" : ` — ${item.docs}`}\n`;
}

export function renderModule(
	mod_: RustdocItem,
	index: Record<string, RustdocItem>,
	crate_: RustdocCrate,
	target: DocsRsTarget,
): string {
	let md = `# ${target.modulePath.join("::")}\n\n`;
	if (mod_.docs !== null && mod_.docs !== "") md += `${mod_.docs}\n\n`;
	const innerMod = mod_.inner as { module?: { items: number[] } };
	const modData = innerMod.module;
	if (!modData?.items) return md;

	const groups = groupModuleItems(modData.items, index);
	for (const kind of KIND_ORDER) {
		const items = groups[kind];
		if (items === undefined || items.length === 0) continue;
		md += `## ${KIND_LABELS[kind] ?? kind}\n\n`;
		for (const item of items) md += renderGroupedItem(item, kind);
		md += "\n";
	}

	if (crate_.crate_version !== null && crate_.crate_version !== "") md += `---\n*${crate_.crate_version}*\n`;
	return md;
}

export function firstLine(s: string): string {
	const line = s.split("\n")[0]?.trim() ?? "";
	return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
