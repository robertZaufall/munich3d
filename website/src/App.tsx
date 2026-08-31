import { useEffect, useState, type SyntheticEvent } from 'react';
import {
  Building2,
  ChevronDown,
  Download,
  ExternalLink,
  Layers3,
  LoaderCircle,
  Plus,
  Ruler,
  Trash2,
  X,
} from 'lucide-react';

import { HouseViewer } from '@/components/house-viewer';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type ModelCatalogEntry = {
  id: string;
  runtime: boolean;
  switchLabel: string;
  address: string;
  district: string;
  modelPath: string;
  sourceMeshPath: string;
  metadataPath: string;
  sourceUrl: string;
  objectId: string;
  gmlId: string;
  width: string;
  depth: string;
  height: string;
  storeys: string;
  ground: string;
  roof: string;
  buildingCount: number;
  neighborCount: number;
  neighborDistance: number;
  neighborSelectionMode: string;
  primaryTriangleCount: number;
  triangleCount: number;
};

const catalogModules = import.meta.glob<{ default: ModelCatalogEntry }>(
  '../lib/model-catalog/*.json',
  { eager: true },
);
const runtimeGenerationEnabled = import.meta.env.MODE !== 'cloudflare';
const staticAssetPath = (assetPath: string) =>
  `${import.meta.env.BASE_URL}${assetPath.replace(/^\//u, '')}`;
const staticPlaces = Object.values(catalogModules)
  .map((module) => ({
    ...module.default,
    modelPath: staticAssetPath(module.default.modelPath),
    sourceMeshPath: staticAssetPath(module.default.sourceMeshPath),
    metadataPath: staticAssetPath(module.default.metadataPath),
  }))
  .sort((left, right) =>
    left.address.localeCompare(right.address, 'de', { sensitivity: 'base' }),
  );

if (staticPlaces.length === 0) {
  throw new Error('No generated model catalog entries found');
}

function mergedPlaces(
  existing: ModelCatalogEntry[],
  additions: ModelCatalogEntry[],
) {
  const key = (model: ModelCatalogEntry) =>
    `${model.gmlId || model.id}:${model.neighborDistance}`;
  const models = new Map(existing.map((model) => [key(model), model]));
  for (const model of additions) models.set(key(model), model);
  return [...models.values()].sort((left, right) =>
    left.address.localeCompare(right.address, 'de', { sensitivity: 'base' }),
  );
}

export default function App() {
  const [places, setPlaces] = useState(staticPlaces);
  const [selectedId, setSelectedId] = useState(staticPlaces[0].id);
  const [showNeighbors, setShowNeighbors] = useState(true);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [neighborDistance, setNeighborDistance] = useState(35);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [deletingModelId, setDeletingModelId] = useState('');
  const [modelActionError, setModelActionError] = useState('');
  const [deleteCandidate, setDeleteCandidate] = useState<ModelCatalogEntry | null>(
    null,
  );
  const place =
    places.find((candidate) => candidate.id === selectedId) ?? places[0];

  useEffect(() => {
    if (!runtimeGenerationEnabled) return undefined;
    let active = true;
    fetch('/api/models')
      .then(async (response) => {
        if (!response.ok) throw new Error('Runtime model catalog is unavailable');
        return response.json();
      })
      .then((result: { models?: ModelCatalogEntry[] }) => {
        if (active && Array.isArray(result.models)) {
          setPlaces((current) => mergedPlaces(current, result.models ?? []));
        }
      })
      .catch(() => {
        // Static models remain usable if the local generation API is unavailable.
      });
    return () => {
      active = false;
    };
  }, []);

  const generateModel = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setGenerating(true);
    setGenerationError('');
    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, neighborDistance }),
      });
      const result = (await response.json()) as {
        model?: ModelCatalogEntry;
        error?: string;
        detail?: string;
      };
      if (!response.ok || !result.model) {
        throw new Error(result.detail || result.error || 'Model generation failed');
      }
      setPlaces((current) => mergedPlaces(current, [result.model!]));
      setSelectedId(result.model.id);
      setShowNeighbors(true);
      setModelActionError('');
      setAddress('');
      setGeneratorOpen(false);
    } catch (error) {
      setGenerationError(
        error instanceof Error ? error.message : 'Model generation failed',
      );
    } finally {
      setGenerating(false);
    }
  };

  const deleteSelectedModel = async (modelToDelete: ModelCatalogEntry) => {
    if (!modelToDelete.runtime) return;
    setDeleteCandidate(null);
    setDeletingModelId(modelToDelete.id);
    setModelActionError('');
    try {
      const response = await fetch(`/api/models/${modelToDelete.id}`, {
        method: 'DELETE',
      });
      const result = (await response.json()) as {
        deletedId?: string;
        error?: string;
        detail?: string;
      };
      if (!response.ok || result.deletedId !== modelToDelete.id) {
        throw new Error(result.detail || result.error || 'Model deletion failed');
      }
      const remaining = mergedPlaces(
        staticPlaces,
        places.filter((candidate) => candidate.id !== modelToDelete.id),
      );
      const equivalentStatic = remaining.find(
        (candidate) =>
          !candidate.runtime &&
          candidate.gmlId === modelToDelete.gmlId &&
          candidate.neighborDistance === modelToDelete.neighborDistance,
      );
      setPlaces(remaining);
      setSelectedId((equivalentStatic ?? remaining[0]).id);
      setShowNeighbors(true);
    } catch (error) {
      setModelActionError(
        error instanceof Error ? error.message : 'Model deletion failed',
      );
    } finally {
      setDeletingModelId('');
    }
  };
  const description = showNeighbors
    ? place.neighborSelectionMode === 'complete_geometry_within_primary_distance'
      ? `The addressed LoD2 building and neighbors whose complete horizontal geometry stays within ${place.neighborDistance} metres of the primary building.`
      : `The addressed LoD2 building and every neighboring building feature within ${place.neighborDistance} metres of its closest horizontal geometry.`
    : 'Neighbor houses are hidden and the camera is fitted to the addressed building.';
  const visibleBuildingCount = !showNeighbors ? 1 : place.buildingCount;
  const visibleTriangleCount = !showNeighbors
    ? place.primaryTriangleCount
    : place.triangleCount;
  const facts = [
    { label: 'Width', value: place.width },
    { label: 'Depth', value: place.depth },
    { label: 'Height', value: place.height },
  ];

  return (
    <main className="min-h-svh overflow-hidden bg-background text-foreground">
      <header className="border-b border-white/8 bg-background/90 px-4 py-3 backdrop-blur-xl sm:px-7">
        <div className="mx-auto flex max-w-[1680px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md border border-cyan-300/20 bg-cyan-300/8 text-cyan-200">
              <Building2 className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-[-0.01em]">
                München LoD2 explorer
              </p>
              <p className="truncate font-sans text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                {places.length} available model bundles
              </p>
            </div>
          </div>

          <div className="flex min-w-0 gap-2 sm:w-[430px]">
            <label className="relative block min-w-0 flex-1">
              <span className="sr-only">Choose building model</span>
              <select
                value={place.id}
                onChange={(event) => setSelectedId(event.target.value)}
                aria-label="Choose building model"
                className="h-10 w-full appearance-none rounded-lg border border-white/9 bg-white/[0.035] px-3 pr-9 font-sans text-[11px] text-stone-100 outline-none transition-colors hover:bg-white/[0.06] focus:border-cyan-200/40"
              >
                {places.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.switchLabel}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-cyan-100/60" />
            </label>
            {runtimeGenerationEnabled && (
              <button
                type="button"
                onClick={() => {
                  setGenerationError('');
                  setGeneratorOpen(true);
                }}
                className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-cyan-200/20 bg-cyan-200/8 px-3 font-sans text-[10px] uppercase tracking-[0.1em] text-cyan-100 transition-colors hover:bg-cyan-200/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/40"
              >
                <Plus className="size-3.5" /> Add address
              </button>
            )}
          </div>
        </div>
      </header>

      {runtimeGenerationEnabled && generatorOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
          <dialog
            open
            aria-labelledby="generator-title"
            className="panel relative m-0 w-full max-w-lg px-6 py-6 text-foreground shadow-2xl"
          >
            <button
              type="button"
              aria-label="Close address generator"
              disabled={generating}
              onClick={() => setGeneratorOpen(false)}
              className="absolute right-4 top-4 grid size-8 place-items-center rounded-md text-white/45 transition-colors hover:bg-white/7 hover:text-white disabled:opacity-30"
            >
              <X className="size-4" />
            </button>
            <p className="eyebrow">On-demand model</p>
            <h2
              id="generator-title"
              className="mt-2 text-2xl font-medium tracking-[-0.035em]"
            >
              Add a Munich address
            </h2>
            <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
              The local server extracts the addressed LoD2 building, adds nearby
              features, and generates a cached GLB without Blender.
            </p>

            <form onSubmit={generateModel} className="mt-6 grid gap-4">
              <label className="grid gap-2">
                <span className="font-sans text-[10px] uppercase tracking-[0.12em] text-stone-300">
                  Address
                </span>
                <input
                  required
                  autoFocus
                  type="text"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="Street, number, postal code, München"
                  className="h-11 rounded-lg border border-white/10 bg-white/[0.035] px-3 text-sm text-stone-100 outline-none placeholder:text-white/25 focus:border-cyan-200/40"
                />
              </label>
              <label className="grid gap-2">
                <span className="font-sans text-[10px] uppercase tracking-[0.12em] text-stone-300">
                  Neighbor distance · metres
                </span>
                <input
                  required
                  type="number"
                  min="0"
                  max="250"
                  step="1"
                  value={neighborDistance}
                  onChange={(event) => setNeighborDistance(Number(event.target.value))}
                  className="h-11 rounded-lg border border-white/10 bg-white/[0.035] px-3 font-sans text-sm text-stone-100 outline-none focus:border-cyan-200/40"
                />
              </label>

              {generationError && (
                <p
                  role="alert"
                  className="rounded-lg border border-rose-300/20 bg-rose-300/7 px-3 py-2 text-xs leading-5 text-rose-100"
                >
                  {generationError}
                </p>
              )}

              <p className="text-[10px] leading-4 text-muted-foreground">
                Address lookup is sent to the configured Esri geocoder. Generated
                files remain in the local ignored runtime cache.
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={generating}
                  onClick={() => setGeneratorOpen(false)}
                  className="h-10 rounded-lg px-4 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={generating || address.trim().length < 3}
                  className="flex h-10 min-w-36 items-center justify-center gap-2 rounded-lg bg-cyan-200 px-4 text-xs font-medium text-[#061014] transition-colors hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {generating ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin" /> Generating
                    </>
                  ) : (
                    'Generate model'
                  )}
                </button>
              </div>
            </form>
          </dialog>
        </div>
      )}

      {runtimeGenerationEnabled && deleteCandidate && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
          <dialog
            open
            aria-labelledby="delete-model-title"
            className="panel relative m-0 w-full max-w-md px-6 py-6 text-foreground shadow-2xl"
          >
            <p className="eyebrow text-rose-200">Delete local model</p>
            <h2
              id="delete-model-title"
              className="mt-2 text-2xl font-medium tracking-[-0.035em]"
            >
              Remove {deleteCandidate.address}?
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              This permanently removes the generated GLB, metadata and source
              mesh from the local runtime cache. Permanent website models are
              unaffected.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteCandidate(null)}
                className="h-10 rounded-lg px-4 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => deleteSelectedModel(deleteCandidate)}
                className={cn(
                  buttonVariants({ variant: 'destructive' }),
                  'h-10 px-4',
                )}
              >
                Delete model <Trash2 className="size-3.5" />
              </button>
            </div>
          </dialog>
        </div>
      )}

      <div className="mx-auto grid max-w-[1680px] gap-3 p-3 lg:h-[calc(100svh-65px)] lg:grid-cols-[minmax(0,1fr)_350px] lg:p-4">
        <section
          aria-label={`Interactive building model for ${place.address}`}
          className="viewer-shell relative min-h-[64svh] overflow-hidden rounded-xl border border-white/9 bg-[#071014] lg:min-h-0"
        >
          <div className="pointer-events-none absolute left-4 top-4 z-10 flex flex-wrap gap-2 sm:left-5 sm:top-5">
            <span className="data-chip">
              <Building2 className="size-3" /> {visibleBuildingCount}{' '}
              {visibleBuildingCount === 1 ? 'building' : 'buildings'}
            </span>
            <span className="data-chip">
              <Layers3 className="size-3" /> {visibleTriangleCount} triangles
            </span>
            <span className="data-chip">
              <Ruler className="size-3" />{' '}
              {showNeighbors
                ? `≤${place.neighborDistance} m neighbors`
                : 'Primary only'}
            </span>
          </div>
          <HouseViewer
            modelPath={place.modelPath}
            address={place.address}
            showNeighbors={showNeighbors}
          />
          <div className="pointer-events-none absolute bottom-4 left-4 z-10 hidden font-sans text-[9px] uppercase tracking-[0.18em] text-white/35 sm:block">
            Drag to orbit · scroll to zoom · right-drag to pan
          </div>
        </section>

        <aside className="flex min-h-0 flex-col gap-3">
          <section className="panel px-5 py-5 sm:px-6 sm:py-6">
            <div className="mb-5 flex items-center justify-between gap-3">
              <p className="eyebrow">Addressed building</p>
              <Badge
                variant="outline"
                className="border-emerald-300/20 bg-emerald-300/5 font-sans text-[9px] uppercase tracking-[0.1em] text-emerald-200"
              >
                Source verified
              </Badge>
            </div>
            <h1 className="max-w-[13ch] text-[clamp(2rem,4vw,3.7rem)] font-medium leading-[0.92] tracking-[-0.055em] lg:text-[2.9rem]">
              {place.address}
            </h1>
            <p className="mt-3 font-sans text-[10px] uppercase tracking-[0.12em] text-cyan-100/60">
              {place.district}
            </p>
            <p className="mt-4 max-w-sm text-sm leading-6 text-muted-foreground">
              {description}
            </p>

            <button
              type="button"
              role="switch"
              aria-checked={showNeighbors}
              onClick={() => setShowNeighbors((visible) => !visible)}
              className="mt-5 flex w-full items-center justify-between rounded-lg border border-white/9 bg-white/[0.025] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/40"
            >
              <span className="flex items-center gap-2.5">
                <Layers3 className="size-4 text-cyan-100/70" />
                <span>
                  <span className="block text-xs font-medium text-stone-200">
                    Show neighbor houses
                  </span>
                  <span className="mt-0.5 block font-sans text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
                    {showNeighbors
                      ? `${place.neighborCount} visible`
                      : 'Primary building only'}
                  </span>
                </span>
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  'relative h-5 w-9 rounded-full border transition-colors',
                  showNeighbors
                    ? 'border-cyan-100/30 bg-cyan-200'
                    : 'border-white/12 bg-white/8',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 size-3.5 rounded-full bg-[#061014] transition-transform',
                    showNeighbors ? 'translate-x-[17px]' : 'translate-x-0.5',
                  )}
                />
              </span>
            </button>

            <div className="mt-6 grid grid-cols-3 border-y border-white/8 py-4">
              {facts.map((fact) => (
                <div
                  key={fact.label}
                  className="border-r border-white/8 px-3 first:pl-0 last:border-0 last:pr-0"
                >
                  <p className="font-sans text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                    {fact.label}
                  </p>
                  <p className="mt-1 text-sm font-medium text-stone-100">
                    {fact.value}
                  </p>
                </div>
              ))}
            </div>

            <dl className="mt-5 grid grid-cols-[1fr_auto] gap-x-5 gap-y-3 text-xs">
              <dt className="text-muted-foreground">Neighbor features</dt>
              <dd className="font-sans text-stone-200">{place.neighborCount}</dd>
              <dt className="text-muted-foreground">Storeys above ground</dt>
              <dd className="font-sans text-stone-200">{place.storeys}</dd>
              <dt className="text-muted-foreground">Ground elevation</dt>
              <dd className="font-sans text-stone-200">{place.ground}</dd>
              <dt className="text-muted-foreground">Roof elevation</dt>
              <dd className="font-sans text-stone-200">{place.roof}</dd>
              <dt className="text-muted-foreground">OBJECTID</dt>
              <dd className="font-sans text-stone-200">{place.objectId}</dd>
              <dt className="text-muted-foreground">GML identifier</dt>
              <dd className="font-sans text-[10px] text-cyan-100">{place.gmlId}</dd>
            </dl>
          </section>

          <section className="panel flex-1 px-5 py-5 sm:px-6">
            <p className="eyebrow mb-4">Selected address data</p>
            <div className="grid gap-2">
              <a
                href={place.modelPath}
                download
                className={cn(
                  buttonVariants(),
                  'h-10 justify-between bg-cyan-200 px-3 text-[#061014] hover:bg-cyan-100',
                )}
              >
                Neighborhood GLB <Download className="size-3.5" />
              </a>
              <a
                href={place.sourceMeshPath}
                download
                className={cn(
                  buttonVariants({ variant: 'outline' }),
                  'h-10 justify-between border-white/10 bg-white/[0.025] px-3 text-stone-200 hover:bg-white/7',
                )}
              >
                Source mesh JSON <Download className="size-3.5" />
              </a>
              <a
                href={place.metadataPath}
                download
                className={cn(
                  buttonVariants({ variant: 'outline' }),
                  'h-10 justify-between border-white/10 bg-white/[0.025] px-3 text-stone-200 hover:bg-white/7',
                )}
              >
                Metadata + distances <Download className="size-3.5" />
              </a>
              <a
                href={place.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  buttonVariants({ variant: 'ghost' }),
                  'h-9 justify-between px-3 text-muted-foreground hover:bg-white/5 hover:text-stone-100',
                )}
              >
                Open ArcGIS source <ExternalLink className="size-3.5" />
              </a>
              {runtimeGenerationEnabled && place.runtime && (
                <button
                  type="button"
                  disabled={deletingModelId === place.id}
                  onClick={() => setDeleteCandidate(place)}
                  className={cn(
                    buttonVariants({ variant: 'destructive' }),
                    'h-9 justify-between px-3',
                  )}
                >
                  {deletingModelId === place.id
                    ? 'Deleting local model'
                    : 'Delete local model'}
                  {deletingModelId === place.id ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </button>
              )}
              {modelActionError && (
                <p
                  role="alert"
                  className="rounded-lg border border-rose-300/20 bg-rose-300/7 px-3 py-2 text-xs leading-5 text-rose-100"
                >
                  {modelActionError}
                </p>
              )}
            </div>
          </section>

          <footer className="px-2 pb-2 pt-1 text-[10px] leading-4 text-muted-foreground">
            <p>© 2026 Robert Zaufall</p>
            <p>Building data: Bayerische Vermessungsverwaltung · CC BY 4.0</p>
          </footer>
        </aside>
      </div>
    </main>
  );
}
