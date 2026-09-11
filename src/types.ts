export type Tool = Record<string, any>;

export interface GraphNode {
  id: string;
  service?: string;
}

export interface Edge {
  from: string;
  to: string;
  label?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: Edge[];
}

export interface OutField {
  name: string;
  parentType: string;
  path: string;
}

export interface InputField {
  name: string;
  tokens: string[];
}
