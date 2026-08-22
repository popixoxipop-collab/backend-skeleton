// A real, oracle-shaped barrel re-export -- the router imports `show` from this file, not from
// './show' directly, so resolving "what does this route actually do" requires following one hop.
export * from './show';
