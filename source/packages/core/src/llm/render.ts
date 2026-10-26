export type TemplateValue = string | number | boolean | null | readonly TemplateValue[] | TemplateInputs;
export type TemplateInputs = { readonly [key: string]: TemplateValue };
export type Includes = Readonly<Record<string, string>>;

type Leaf = { kind: "text" | "value" | "include"; value: string; raw?: string };
type Block = { kind: "if" | "each"; path: string; children: Node[]; otherwise?: Node[]; open: string; close: string; separator?: string };
type Node = Leaf | Block;
type Scope = { root: TemplateInputs; current?: TemplateValue; index?: number };

function checkPath(path: string): string {
  if (!/^(?:@index|[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)$/.test(path)) {
    throw new Error("Invalid value path");
  }
  return path;
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: { block: Block; parent: Node[] }[] = [];
  let nodes = root;
  let offset = 0;
  while (offset < template.length) {
    const start = template.indexOf("{{", offset);
    if (start === -1) {
      nodes.push({ kind: "text", value: template.slice(offset) });
      break;
    }
    if (start > offset) nodes.push({ kind: "text", value: template.slice(offset, start) });
    const end = template.indexOf("}}", start + 2);
    if (end === -1) throw new Error("Unclosed template tag");
    const tag = template.slice(start + 2, end).trim();
    offset = end + 2;
    const opening = /^#(if|each)\s+(.+)$/.exec(tag);
    if (opening) {
      const block: Block = {
        kind: opening[1] as Block["kind"], path: checkPath(opening[2]), children: [], open: template.slice(start, offset), close: "",
      };
      nodes.push(block);
      stack.push({ block, parent: nodes });
      nodes = block.children;
    } else if (tag === "else") {
      const frame = stack.at(-1);
      if (!frame || frame.block.kind !== "if" || frame.block.otherwise) {
        throw new Error("Unexpected else");
      }
      frame.block.separator = template.slice(start, offset);
      nodes = frame.block.otherwise = [];
    } else if (tag.startsWith("/")) {
      const frame = stack.pop();
      if (!frame || tag !== `/${frame.block.kind}`) throw new Error("Mismatched block end");
      frame.block.close = template.slice(start, offset);
      nodes = frame.parent;
    } else if (tag.startsWith("include ")) {
      const name = tag.slice(8).trim();
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid include name");
      nodes.push({ kind: "include", value: name, raw: template.slice(start, offset) });
    } else {
      nodes.push({ kind: "value", value: checkPath(tag), raw: template.slice(start, offset) });
    }
  }
  if (stack.length) throw new Error("Unclosed template block");
  return root;
}

// Version only the chosen settings branches; job data and other template tags must keep their original bytes.
export function renderConditions(template: string, conditions: Readonly<Record<string, boolean>>): string {
  function emit(nodes: Node[]): string {
    return nodes.map(node => {
      if (node.kind === "text") return node.value;
      if (node.kind === "value" || node.kind === "include") return node.raw!;
      const block = node as Block;
      if (block.kind === "if" && Object.hasOwn(conditions, block.path)) {
        return emit(conditions[block.path] ? block.children : block.otherwise ?? []);
      }
      return block.open + emit(block.children) + (block.otherwise ? block.separator + emit(block.otherwise) : "") + block.close;
    }).join("");
  }
  return emit(parse(template));
}

function lookup(path: string, scope: Scope): TemplateValue {
  if (path === "@index") {
    if (scope.index === undefined) throw new Error("No current item");
    return scope.index;
  }
  const parts = path.split(".");
  let value: TemplateValue = scope.root;
  if (parts[0] === "this") {
    if (scope.index === undefined) throw new Error("No current item");
    value = scope.current!;
    parts.shift();
  }
  for (const part of parts) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) {
      throw new Error(`Missing value: ${path}`);
    }
    // This lookup only reads an own property checked above and never writes to an object.
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop
    value = (value as TemplateInputs)[part];
  }
  return value;
}

// Parse only trusted templates. Inserted values are emitted as text and never parsed again.
export function render(template: string, inputs: TemplateInputs, includes: Includes = {}): string {
  const parsedIncludes = new Map<string, Node[]>();
  function emit(nodes: Node[], scope: Scope, ancestry: string[]): string {
    return nodes.map(node => {
      if (node.kind === "text") return node.value;
      if (node.kind === "include") {
        const name = node.value;
        if (!Object.hasOwn(includes, name)) throw new Error(`Unknown include: ${name}`);
        if (ancestry.includes(name)) throw new Error(`Include cycle: ${name}`);
        if (!parsedIncludes.has(name)) parsedIncludes.set(name, parse(includes[name]));
        return emit(parsedIncludes.get(name)!, scope, [...ancestry, name]);
      }
      if (node.kind === "value") {
        const value = lookup(node.value, scope);
        if (value !== null && typeof value === "object") throw new Error(`Expected scalar: ${node.value}`);
        return value === null ? "" : String(value);
      }
      const block = node as Block;
      const value = lookup(block.path, scope);
      if (block.kind === "if") {
        const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
        return emit(truthy ? block.children : block.otherwise ?? [], scope, ancestry);
      }
      if (!Array.isArray(value)) throw new Error(`Expected array: ${block.path}`);
      return value.map((current, index) => emit(block.children, {
        root: scope.root, current, index,
      }, ancestry)).join("");
    }).join("");
  }
  return emit(parse(template), { root: inputs }, []);
}
