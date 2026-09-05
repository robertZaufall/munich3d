import { useEffect, useState, type SyntheticEvent } from 'react';
import {
  Building2,
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

export type ModelCatalogEntry = {
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
  verticalDatum?: string | null;
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
  areaSurfacePath?: string;
  architectureStyle?: 'generic' | 'gothic';
};

const catalogModules = import.meta.glob<{ default: ModelCatalogEntry }>(
  '../addresses/*/catalog/*.json',
  { eager: true },
);
const browserGenerationEnabled = import.meta.env.MODE === 'cloudflare';
const runtimeApiPath = (path: string) =>
  `${import.meta.env.BASE_URL}api/${path.replace(/^\//u, '')}`;
const staticAssetPath = (assetPath: string) =>
  `${import.meta.env.BASE_URL}${assetPath.replace(/^\//u, '')}`;
const staticPlaces: ModelCatalogEntry[] = Object.values(catalogModules)
  .map((module) => ({
    ...module.default,
    modelPath: staticAssetPath(module.default.modelPath),
    sourceMeshPath: staticAssetPath(module.default.sourceMeshPath),
    metadataPath: staticAssetPath(module.default.metadataPath),
    areaSurfacePath: module.default.areaSurfacePath ? staticAssetPath(module.default.areaSurfacePath) : undefined,
  }))
  .sort((left, right) =>
    left.address.localeCompare(right.address, 'de', { sensitivity: 'base' }),
  );

if (staticPlaces.length === 0) {
  throw new Error('No generated model catalog entries found');
}

const initialView = new URLSearchParams(window.location.search);
const requestedModelId = initialView.get('model') ?? initialView.get('area');
const initialModelId = requestedModelId === 'muenchner-rathaus-35m' ? 'muenchner-rathaus-100m' : requestedModelId;
const defaultPlace = staticPlaces.find(model => model.id === 'muenchner-rathaus-100m') ?? staticPlaces[0];

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
  const [runtimeCatalogLoaded, setRuntimeCatalogLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState(
    initialModelId ?? defaultPlace.id,
  );
  const [infoOpen, setInfoOpen] = useState(false);
  const [controlsTarget, setControlsTarget] = useState<HTMLDivElement | null>(null);
  const [showReconstruction, setShowReconstruction] = useState(initialView.get('view') === 'reconstruction');
  const [primaryGroup, setPrimaryGroup] = useState<{ modelPath: string; count: number; triangles: number } | null>(null);
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
    places.find((candidate) => candidate.id === selectedId) ?? defaultPlace;

  const locationKey = (model: ModelCatalogEntry) => model.gmlId || model.address.trim().toLocaleLowerCase('de');
  const locations = [...new Map(places.map(model => [locationKey(model), model])).values()];
  const areaVariants = places.filter(model => locationKey(model) === locationKey(place)).sort((a, b) => a.neighborDistance - b.neighborDistance);
  const selectLocation = (location: ModelCatalogEntry) => {
    const variants = places.filter(model => locationKey(model) === locationKey(location));
    const next = variants.find(model => model.neighborDistance === place.neighborDistance)
      ?? (showReconstruction ? variants.find(model => model.areaSurfacePath) : undefined)
      ?? variants[0];
    setSelectedId(next.id);
  };

  useEffect(() => {
    // Keep a runtime model's URL until its asynchronous cache catalog arrives.
    if (!runtimeCatalogLoaded && !places.some(model => model.id === selectedId)) return;
    const params = new URLSearchParams();
    params.set('model', place.id);
    if (showReconstruction && place.areaSurfacePath) params.set('view', 'reconstruction');
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
  }, [place.id, place.areaSurfacePath, showReconstruction, runtimeCatalogLoaded, places, selectedId]);

  useEffect(() => {
    let active = true;
    const models = browserGenerationEnabled
      ? import('@/lib/browser-models').then(({ listBrowserModels }) =>
          listBrowserModels().then((runtimeModels) => ({ models: runtimeModels })),
        )
      : fetch(runtimeApiPath('models'))
      .then(async (response) => {
        if (!response.ok) throw new Error('Runtime model catalog is unavailable');
        return response.json();
      });
    models
      .then((result) => {
        if (active && Array.isArray(result.models)) {
          setPlaces((current) =>
            mergedPlaces(current, result.models as ModelCatalogEntry[]),
          );
        }
      })
      .catch(() => {
        // Static models remain usable if the local generation API is unavailable.
      })
      .finally(() => { if (active) setRuntimeCatalogLoaded(true); });
    return () => {
      active = false;
    };
  }, []);

  const generateModel = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setGenerating(true);
    setGenerationError('');
    try {
      let result: {
        model?: ModelCatalogEntry;
        error?: string;
        detail?: string;
      };
      let successful = true;
      if (browserGenerationEnabled) {
        const { generateBrowserModel } = await import('@/lib/browser-models');
        result = (await generateBrowserModel({ address, neighborDistance })) as unknown as {
          model: ModelCatalogEntry;
        };
      } else {
        const response = await fetch(runtimeApiPath('models'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, neighborDistance }),
        });
        successful = response.ok;
        result = (await response.json()) as typeof result;
      }
      if (!successful || !result.model) {
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
      let result: {
        deletedId?: string;
        error?: string;
        detail?: string;
      };
      let successful = true;
      if (browserGenerationEnabled) {
        const { deleteBrowserModel } = await import('@/lib/browser-models');
        result = await deleteBrowserModel(modelToDelete.id);
      } else {
        const response = await fetch(
          runtimeApiPath(`models/${modelToDelete.id}`),
          { method: 'DELETE' },
        );
        successful = response.ok;
        result = (await response.json()) as typeof result;
      }
      if (!successful || result.deletedId !== modelToDelete.id) {
        throw new Error(result.detail || result.error || 'Model deletion failed');
      }
      for (const path of [
        modelToDelete.modelPath,
        modelToDelete.sourceMeshPath,
        modelToDelete.metadataPath,
      ]) {
        if (path.startsWith('blob:')) URL.revokeObjectURL(path);
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
  const activePrimaryGroup = primaryGroup?.modelPath === place.modelPath ? primaryGroup : null;
  const visibleBuildingCount = !showNeighbors ? activePrimaryGroup?.count ?? 1 : place.buildingCount;
  const visibleTriangleCount = !showNeighbors
    ? activePrimaryGroup?.triangles ?? place.primaryTriangleCount
    : place.triangleCount;
  const facts = [
    { label: 'Width', value: place.width },
    { label: 'Depth', value: place.depth },
    { label: 'Height', value: place.height },
  ];



  return (
    <main className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="shrink-0 border-b border-white/8 bg-background/90 px-4 py-3 backdrop-blur-xl sm:px-7">
        <div className="mx-auto flex max-w-[1680px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md border border-cyan-300/20 bg-cyan-300/8 text-cyan-200">
              <Building2 className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-[-0.01em]">
                3D building explorer
              </p>
              <p className="truncate font-sans text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                {locations.length} available locations
              </p>
            </div>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
            <nav aria-label="Choose location" className="flex flex-wrap gap-2">
              {locations.map(location => {
                const selected = locationKey(location) === locationKey(place);
                return <button key={locationKey(location)} type="button" aria-pressed={selected} onClick={() => selectLocation(location)} className={cn('min-h-12 rounded-lg border px-4 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200', selected ? 'border-cyan-200 bg-cyan-200 text-[#061014]' : 'border-white/15 bg-white/5 text-stone-100 hover:bg-white/10')}>{location.address}</button>;
              })}
            </nav>
            <button
              type="button"
              onClick={() => {
                setGenerationError('');
                setGeneratorOpen(true);
              }}
              className="flex h-12 shrink-0 items-center gap-1.5 rounded-lg border border-cyan-200/20 bg-cyan-200/8 px-3 font-sans text-[10px] uppercase tracking-[0.1em] text-cyan-100 transition-colors hover:bg-cyan-200/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/40"
            >
              <Plus className="size-3.5" /> Add address
            </button>
          </div>
        </div>
      </header>

      {generatorOpen && (
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
              Add a Bavarian address
            </h2>
            <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
              {browserGenerationEnabled ? 'Your browser' : 'The local service'} extracts the addressed LoD2 building, adds nearby
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
                  placeholder="Street, number, postal code, town"
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
                files are cached {browserGenerationEnabled ? 'in this browser' : 'locally'}
                {' '}and can be deleted again.
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

      {deleteCandidate && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
          <dialog
            open
            aria-labelledby="delete-model-title"
            className="panel relative m-0 w-full max-w-md px-6 py-6 text-foreground shadow-2xl"
          >
            <p className="eyebrow text-rose-200">Delete generated model</p>
            <h2
              id="delete-model-title"
              className="mt-2 text-2xl font-medium tracking-[-0.035em]"
            >
              Remove {deleteCandidate.address}?
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              This permanently removes the generated GLB, metadata and source
              mesh from the generated-model cache. Permanent website models are
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

      <div className="mx-auto grid min-h-0 w-full max-w-[1680px] flex-1 gap-3 p-3 md:grid-cols-[minmax(0,1fr)_300px] lg:p-4">
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
        <section
          aria-label={`Interactive building model for ${place.address}`}
          className="viewer-shell relative min-h-0 flex-1 overflow-hidden rounded-xl border border-white/9 bg-[#071014]"
        >
          <div className="pointer-events-none absolute left-4 top-4 z-10 flex flex-wrap gap-2 sm:left-5 sm:top-5">
            <span className="data-chip">
              <Building2 className="size-3" /> {visibleBuildingCount}{' '}
              {!showNeighbors && visibleBuildingCount > 1 ? 'building parts' : visibleBuildingCount === 1 ? 'building' : 'buildings'}
            </span>
            <span className="data-chip">
              <Layers3 className="size-3" /> {visibleTriangleCount} triangles
            </span>
            <span className="data-chip">
              <Ruler className="size-3" />{' '}
              {showNeighbors
                ? `≤${place.neighborDistance} m neighbors`
                : 'Selected building'}
            </span>
          </div>
          <HouseViewer
            onPrimaryGroupReady={setPrimaryGroup}
            onInformationOpen={() => setInfoOpen(true)}
            controlsTarget={controlsTarget}
            neighborCount={place.neighborCount}
            onNeighborsChange={setShowNeighbors}
            onReconstructionChange={setShowReconstruction}
            reconstructArea={Boolean(place.areaSurfacePath)}
            areaSurfacePath={place.areaSurfacePath}
            showReconstruction={showReconstruction}
            modelPath={place.modelPath}
            address={place.address}
            showNeighbors={showNeighbors}
          />
          <div className="pointer-events-none absolute bottom-4 left-4 z-10 hidden font-sans text-[9px] uppercase tracking-[0.18em] text-white/35 sm:block">
            Drag to orbit · scroll to zoom · right-drag to pan
          </div>
        </section>

        <div ref={setControlsTarget} className="shrink-0" />
        </div>
        <aside aria-label="Building information" className={cn('min-h-0 flex-col gap-2 overflow-y-auto md:static md:flex md:w-auto md:border-0 md:bg-transparent md:p-0', infoOpen ? 'fixed inset-y-3 right-3 z-40 flex w-[min(320px,calc(100vw-24px))] rounded-xl border border-white/15 bg-[#071014] p-3' : 'hidden')}>
          <button type="button" onClick={() => setInfoOpen(false)} className="min-h-10 shrink-0 rounded-lg border border-white/15 text-sm md:hidden">Close information</button>
          <section className="panel shrink-0 px-4 py-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="eyebrow">Addressed building</p>
              <Badge
                variant="outline"
                className="border-emerald-300/20 bg-emerald-300/5 font-sans text-[9px] uppercase tracking-[0.1em] text-emerald-200"
              >
                LoD2 source
              </Badge>
            </div>
            <h1 className="text-3xl font-medium leading-tight tracking-tight">
              {place.address}
            </h1>
            <p className="mt-3 font-sans text-[10px] uppercase tracking-[0.12em] text-cyan-100/60">
              {place.district}
            </p>
            <p className="mt-3 max-w-sm text-xs leading-4 text-muted-foreground">
              {description}
            </p>

      {areaVariants.length > 1 && <nav aria-label="Available area sizes" className="mt-4 flex flex-wrap items-center gap-2">
        <span className="w-full text-xs text-muted-foreground">Available area sizes</span>
        {areaVariants.map(variant => <button key={variant.id} type="button" aria-pressed={variant.id === place.id} onClick={() => setSelectedId(variant.id)} className={cn('min-h-12 rounded-lg border px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200', variant.id === place.id ? 'border-cyan-200 bg-cyan-200 text-[#061014]' : 'border-white/15 bg-white/5 text-stone-100')}>{variant.neighborDistance} m area</button>)}
      </nav>}

            <div className="mt-4 grid grid-cols-3 border-y border-white/8 py-3">
              {facts.map((fact) => (
                <div
                  key={fact.label}
                  className="border-r border-white/8 px-3 first:pl-0 last:border-0 last:pr-0"
                >
                  <p className="font-sans text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                    {fact.label}
                  </p>
                  <p className="mt-1 whitespace-nowrap text-xs font-medium text-stone-100">
                    {fact.value}
                  </p>
                </div>
              ))}
            </div>

            <details open className="mt-3"><summary className="cursor-pointer text-sm text-cyan-100">Building measurements & IDs</summary>
            <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-5 gap-y-3 text-xs">
              <dt className="text-muted-foreground">Neighbor features</dt>
              <dd className="font-sans text-stone-200">{place.neighborCount}</dd>
              <dt className="text-muted-foreground">Storeys above ground</dt>
              <dd className="font-sans text-stone-200">{place.storeys}</dd>
              <dt className="text-muted-foreground">Ground elevation{place.verticalDatum ? ' (ellipsoid)' : ''}</dt>
              <dd className="font-sans text-stone-200">{place.ground}</dd>
              <dt className="text-muted-foreground">Roof elevation{place.verticalDatum ? ' (ellipsoid)' : ''}</dt>
              <dd className="font-sans text-stone-200">{place.roof}</dd>
              <dt className="text-muted-foreground">OBJECTID</dt>
              <dd className="font-sans text-stone-200">{place.objectId}</dd>
              <dt className="text-muted-foreground">GML identifier</dt>
              <dd className="font-sans text-[10px] text-cyan-100">{place.gmlId}</dd>
            </dl>
            </details>
          </section>

          <details open className="panel shrink-0 px-4 py-3">
            <summary className="cursor-pointer text-sm text-cyan-100">Downloads & source data</summary>
            <div className="mt-3 grid gap-2">
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
                Open source model <ExternalLink className="size-3.5" />
              </a>
              {place.runtime && (
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
                    ? 'Deleting generated model'
                    : 'Delete generated model'}
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
          </details>

          <footer className="mt-auto shrink-0 px-2 pb-2 pt-1 text-[10px] leading-4 text-muted-foreground">
            <p>© 2026 Robert Zaufall</p>
            <p>Building data: <a href="https://www.geodaten.bayern.de" className="hover:underline">Bayerische Vermessungsverwaltung – www.geodaten.bayern.de</a> · CC BY 4.0</p>
            {place.areaSurfacePath && <p>Surface data: <a href="https://www.openstreetmap.org/copyright" className="hover:underline">© OpenStreetMap contributors · ODbL</a></p>}
          </footer>
        </aside>
      </div>
    </main>
  );
}
