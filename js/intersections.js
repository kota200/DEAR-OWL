export function buildDirectionMatrix(contrastResults) {
  const rowsByGene = new Map();

  for (const contrast of contrastResults) {
    for (const row of contrast.rows) {
      if (!rowsByGene.has(row.gene_id)) {
        rowsByGene.set(row.gene_id, { gene_id: row.gene_id });
      }
      rowsByGene.get(row.gene_id)[contrast.id] = row.direction || "NA";
    }
  }

  return [...rowsByGene.values()].sort((a, b) =>
    String(a.gene_id).localeCompare(String(b.gene_id))
  );
}

export function buildGeneSet(contrast, direction) {
  return new Set(
    contrast.rows
      .filter((row) => row.direction === direction)
      .map((row) => row.gene_id)
  );
}

export function computeExclusiveIntersections(sets) {
  const allGenes = new Set();

  for (const set of sets) {
    for (const geneId of set.genes) {
      allGenes.add(geneId);
    }
  }

  const intersections = new Map();
  for (const geneId of allGenes) {
    const membership = sets.map((set) => set.genes.has(geneId));
    const key = membership.map((included) => included ? "1" : "0").join("");
    if (!intersections.has(key)) {
      intersections.set(key, {
        key,
        membership,
        genes: []
      });
    }
    intersections.get(key).genes.push(geneId);
  }

  return [...intersections.values()]
    .filter((entry) => entry.genes.length > 0)
    .sort((a, b) => b.genes.length - a.genes.length || a.key.localeCompare(b.key));
}
