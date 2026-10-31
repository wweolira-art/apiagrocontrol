/**
 * Polígonos do mapa via ORDS MAPA_TALHAO.
 * Mantido neste arquivo (sem importar src/) porque o Node ESM exige extensão nas importações.
 */

export interface MapaFeature {
  type: 'Feature';
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: unknown;
  };
  properties: Record<string, unknown>;
}

type Position = [number, number];

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseWktRing(text: string): Position[] | null {
  const pairs = [...text.matchAll(/(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)];
  const ring: Position[] = pairs.map((match) => [Number(match[1]), Number(match[2])]);
  return ring.length >= 4 ? ring : null;
}

function parseGeometry(value: unknown): MapaFeature['geometry'] | null {
  if (value && typeof value === 'object') {
    const obj = value as { type?: string; coordinates?: unknown; geometry?: unknown };
    if (obj.type === 'Feature') {
      return parseGeometry(obj.geometry);
    }
    if ((obj.type === 'Polygon' || obj.type === 'MultiPolygon') && obj.coordinates) {
      return { type: obj.type, coordinates: obj.coordinates };
    }
    const polygon = (obj as { polygon?: { boundary?: Array<{ line?: { datapoints?: unknown } }> } }).polygon;
    if (Array.isArray(polygon?.boundary)) {
      const rings = polygon.boundary
        .map((part) => part.line?.datapoints)
        .filter((pts): pts is unknown[] => Array.isArray(pts) && pts.length >= 3);
      if (rings.length > 0) {
        return { type: 'Polygon', coordinates: rings };
      }
    }
  }
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  if (text.startsWith('{')) {
    try {
      return parseGeometry(JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  }
  const rings: Position[][] = [];
  const re = /\(([^()]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const ring = parseWktRing(match[1] ?? '');
    if (ring) {
      rings.push(ring);
    }
  }
  if (rings.length === 0) {
    return null;
  }
  if (/MULTIPOLYGON/i.test(text)) {
    return { type: 'MultiPolygon', coordinates: rings.map((ring) => [ring]) };
  }
  return { type: 'Polygon', coordinates: rings };
}

function rowToFeature(row: Record<string, unknown>): MapaFeature | null {
  const geometry = parseGeometry(row.geojson) ?? parseGeometry(row.geometria);
  if (!geometry) {
    return null;
  }
  return {
    type: 'Feature',
    geometry,
    properties: {
      id: row.id_externo ?? row.id_talhao,
      Fazenda: String(row.fazenda ?? '').trim() || undefined,
      Lote: row.lote,
      Cod_fazend: row.cod_fazenda,
      Campo: String(row.campo ?? '').trim() || undefined,
      Produtor: String(row.produtor ?? '').trim() || undefined,
      sec_Id: String(row.sec_id ?? '').trim() || undefined,
    },
  };
}

export async function carregarMapaOrds(baseUrl: string): Promise<MapaFeature[]> {
  const features: MapaFeature[] = [];
  let url: string | null = `${baseUrl.replace(/\/$/, '')}/?limit=1000`;

  while (url) {
    const atual: string = url;
    const resposta = await fetch(atual, { headers: { Accept: 'application/json' } });
    if (!resposta.ok) {
      throw new Error(`API mapa_talhao HTTP ${resposta.status}`);
    }
    const data = (await resposta.json()) as {
      items?: Array<Record<string, unknown>>;
      hasMore?: boolean;
      links?: Array<{ rel?: string; href?: string }>;
    };
    for (const row of data.items ?? []) {
      const feature = rowToFeature(row);
      if (feature) {
        features.push(feature);
      }
    }
    url = data.links?.find((link) => link.rel === 'next')?.href ?? null;
    if (!url && data.hasMore) {
      const parsed: URL = new URL(atual);
      const offset = Number(parsed.searchParams.get('offset') ?? 0);
      const limit = Number(parsed.searchParams.get('limit') ?? 1000);
      parsed.searchParams.set('offset', String(offset + limit));
      url = parsed.toString();
    }
  }

  return features;
}
