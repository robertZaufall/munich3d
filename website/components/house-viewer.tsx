import { useEffect, useRef, useState } from 'react';
import {
  Focus,
  Layers3,
  LoaderCircle,
  Navigation2,
  Pause,
  Play,
  ScanLine,
} from 'lucide-react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { Button } from '@/components/ui/button';

const compassPoints = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function setNeighborVisibility(model: THREE.Group, showNeighbors: boolean) {
  for (const child of model.children) {
    child.visible = child.userData.role !== 'neighbor' || showNeighbors;
  }
  model.updateMatrixWorld(true);
}

export function HouseViewer({
  modelPath,
  address,
  showNeighbors,
}: {
  modelPath: string;
  address: string;
  showNeighbors: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const compassNeedleRef = useRef<HTMLDivElement>(null);
  const compassLabelRef = useRef<HTMLSpanElement>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const modelRef = useRef<THREE.Group | null>(null);
  const fitViewRef = useRef<(() => void) | null>(null);
  const showNeighborsRef = useRef(showNeighbors);
  const depthMapRef = useRef(false);
  const homePositionRef = useRef(new THREE.Vector3(37, 29, 43));
  const homeTargetRef = useRef(new THREE.Vector3(0, 8, 0));
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [autoRotate, setAutoRotate] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [depthMap, setDepthMap] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let active = true;
    setStatus('loading');
    modelRef.current = null;

    const scene = new THREE.Scene();
    const sceneFog = new THREE.FogExp2(0x071014, 0.0115);
    scene.fog = sceneFog;

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
    camera.position.set(37, 29, 43);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.22;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.minDistance = 24;
    controls.maxDistance = 105;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.autoRotateSpeed = 0.48;
    controls.target.set(0, 8, 0);
    controlsRef.current = controls;

    scene.add(new THREE.HemisphereLight(0xd9f5f6, 0x60777a, 2.6));
    const key = new THREE.DirectionalLight(0xfff1da, 2.5);
    key.position.set(24, 42, 30);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -90;
    key.shadow.camera.right = 90;
    key.shadow.camera.top = 90;
    key.shadow.camera.bottom = -90;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 220;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.04;
    key.shadow.radius = 5;
    key.shadow.blurSamples = 16;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9be7ef, 1.7);
    rim.position.set(-26, 20, -22);
    scene.add(rim);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(1, 128),
      new THREE.MeshStandardMaterial({
        color: 0x0b171c,
        roughness: 1,
        metalness: 0,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.04;
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(2, 45, 0x2a6c78, 0x17353c);
    grid.position.y = 0.015;
    const gridMaterials = Array.isArray(grid.material)
      ? grid.material
      : [grid.material];
    for (const material of gridMaterials) {
      material.transparent = true;
      material.opacity = 0.24;
    }
    scene.add(grid);

    const depthMaterial = new THREE.ShaderMaterial({
      uniforms: {
        nearDepth: { value: 0 },
        farDepth: { value: 1 },
      },
      vertexShader: `
        varying float viewDepth;

        void main() {
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          viewDepth = -viewPosition.z;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        uniform float nearDepth;
        uniform float farDepth;
        varying float viewDepth;

        void main() {
          float depthRange = max(farDepth - nearDepth, 0.0001);
          float normalizedDepth = clamp((viewDepth - nearDepth) / depthRange, 0.0, 1.0);
          float shade = 1.0 - normalizedDepth;
          gl_FragColor = vec4(vec3(shade), 1.0);
        }
      `,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const depthBox = new THREE.Box3();
    const depthSphere = new THREE.Sphere();
    const depthDirection = new THREE.Vector3();
    const depthOffset = new THREE.Vector3();
    const compassDirection = new THREE.Vector3();

    const updateDepthRange = () => {
      const model = modelRef.current;
      if (!model) return;

      depthBox.makeEmpty();
      for (const child of model.children) {
        if (child.visible) depthBox.expandByObject(child, true);
      }
      if (depthBox.isEmpty()) return;

      depthBox.getBoundingSphere(depthSphere);
      camera.getWorldDirection(depthDirection);
      depthOffset.copy(depthSphere.center).sub(camera.position);
      const centerDepth = depthOffset.dot(depthDirection);
      const nearDepth = Math.max(0, centerDepth - depthSphere.radius);
      const farDepth = Math.max(nearDepth + 0.01, centerDepth + depthSphere.radius);
      depthMaterial.uniforms.nearDepth.value = nearDepth;
      depthMaterial.uniforms.farDepth.value = farDepth;
    };

    const loader = new GLTFLoader();
    loader.load(
      modelPath,
      (gltf) => {
        if (!active) return;
        const model = gltf.scene;
        modelRef.current = model;
        const primary = model.children.find(
          (child) => child.userData.role === 'primary',
        );
        const initialBox = new THREE.Box3().setFromObject(model);
        const focusBox = primary ? new THREE.Box3().setFromObject(primary) : initialBox;
        const focusCenter = focusBox.getCenter(new THREE.Vector3());
        model.position.x -= focusCenter.x;
        model.position.z -= focusCenter.z;
        model.updateMatrixWorld(true);
        const shiftedBox = new THREE.Box3().setFromObject(model);
        model.position.y -= shiftedBox.min.y;
        model.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          child.castShadow = true;
          child.receiveShadow = true;
          const materials = Array.isArray(child.material)
            ? child.material
            : [child.material];
          for (const material of materials) {
            material.side = THREE.DoubleSide;
            if (material instanceof THREE.MeshStandardMaterial) {
              material.envMapIntensity = 0.75;
            }
          }
        });
        scene.add(model);
        model.updateMatrixWorld(true);

        const fitVisibleModel = () => {
          const visibleBox = new THREE.Box3().makeEmpty();
          for (const child of model.children) {
            if (child.visible) visibleBox.expandByObject(child, true);
          }
          if (visibleBox.isEmpty()) return;

          const sphere = visibleBox.getBoundingSphere(new THREE.Sphere());
          const target = visibleBox.getCenter(new THREE.Vector3());
          const footprint = visibleBox.getSize(new THREE.Vector3());
          const groundRadius = Math.max(
            10,
            Math.hypot(footprint.x, footprint.z) * 0.625,
          );
          const direction = new THREE.Vector3(1.08, 0.78, 1.14).normalize();
          camera.aspect = mount.clientWidth / Math.max(mount.clientHeight, 1);
          const verticalFov = THREE.MathUtils.degToRad(camera.fov);
          const horizontalFov = 2 * Math.atan(
            Math.tan(verticalFov / 2) * camera.aspect,
          );
          const fitHalfFov = Math.min(verticalFov, horizontalFov) / 2;
          const distance = Math.max(
            18,
            (sphere.radius / Math.sin(fitHalfFov)) * 1.12,
          );
          const home = target.clone().addScaledVector(direction, distance);

          ground.position.set(target.x, -0.04, target.z);
          ground.scale.setScalar(groundRadius);
          grid.position.set(target.x, 0.015, target.z);
          grid.scale.setScalar(groundRadius * Math.SQRT1_2);
          mount.dataset.groundRadiusMetres = groundRadius.toFixed(2);
          sceneFog.density = Math.min(0.0115, 0.55 / distance);
          homePositionRef.current.copy(home);
          homeTargetRef.current.copy(target);
          camera.position.copy(home);
          camera.near = Math.max(0.05, sphere.radius / 150);
          camera.far = Math.max(500, distance + sphere.radius * 12);
          camera.updateProjectionMatrix();
          controls.target.copy(target);
          controls.minDistance = Math.max(4, sphere.radius * 0.45);
          controls.maxDistance = Math.max(120, distance * 2.25);
          controls.update();
        };

        fitViewRef.current = fitVisibleModel;
        setNeighborVisibility(model, showNeighborsRef.current);
        fitVisibleModel();
        setStatus('ready');
      },
      undefined,
      () => {
        if (active) setStatus('error');
      },
    );

    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      fitViewRef.current?.();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    let frame = 0;
    let previousHeading = -1;
    const render = () => {
      controls.update();
      camera.getWorldDirection(compassDirection);
      // The GLB export maps source +Y north to Three.js -Z.
      const bearing =
        (THREE.MathUtils.radToDeg(
          Math.atan2(compassDirection.x, -compassDirection.z),
        ) +
          360) %
        360;
      if (compassNeedleRef.current) {
        compassNeedleRef.current.style.transform = `rotate(${-bearing}deg)`;
      }
      const roundedHeading = Math.round(bearing) % 360;
      if (roundedHeading !== previousHeading && compassLabelRef.current) {
        const point = compassPoints[Math.round(bearing / 45) % compassPoints.length];
        compassLabelRef.current.textContent = `${point} ${String(roundedHeading).padStart(3, '0')}°`;
        mount.dataset.cameraHeadingDegrees = bearing.toFixed(1);
        previousHeading = roundedHeading;
      }
      const renderDepthMap = depthMapRef.current;
      ground.visible = !renderDepthMap;
      grid.visible = !renderDepthMap;
      scene.fog = renderDepthMap ? null : sceneFog;
      scene.overrideMaterial = renderDepthMap ? depthMaterial : null;
      if (renderDepthMap) updateDepthRange();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();

    return () => {
      active = false;
      fitViewRef.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      depthMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) material.dispose();
      });
    };
  }, [modelPath]);

  useEffect(() => {
    showNeighborsRef.current = showNeighbors;
    const model = modelRef.current;
    if (!model) return;
    setNeighborVisibility(model, showNeighbors);
    fitViewRef.current?.();
  }, [showNeighbors]);

  useEffect(() => {
    if (controlsRef.current) controlsRef.current.autoRotate = autoRotate;
  }, [autoRotate]);

  useEffect(() => {
    depthMapRef.current = depthMap;
  }, [depthMap]);

  useEffect(() => {
    modelRef.current?.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      for (const material of materials) {
        if (material instanceof THREE.MeshStandardMaterial) {
          material.wireframe = wireframe;
          material.needsUpdate = true;
        }
      }
    });
  }, [wireframe]);

  const toggleDepthMap = () => setDepthMap((enabled) => !enabled);

  const resetView = () => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    camera.position.copy(homePositionRef.current);
    controls.target.copy(homeTargetRef.current);
    controls.update();
  };

  return (
    <div
      ref={mountRef}
      className="absolute inset-0"
      data-model-status={status}
      data-neighbors-visible={showNeighbors}
      data-depth-map={depthMap}
      aria-label={`Three-dimensional model of ${address}`}
    >
      {status !== 'ready' && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-[#071014]">
          <div className="text-center">
            {status === 'loading' ? (
              <LoaderCircle className="mx-auto size-5 animate-spin text-cyan-200" />
            ) : (
              <p className="text-sm text-rose-200">The model could not be loaded.</p>
            )}
            <p className="mt-3 font-sans text-[9px] uppercase tracking-[0.18em] text-white/35">
              {status === 'loading' ? 'Loading building geometry' : 'GLB load error'}
            </p>
          </div>
        </div>
      )}

      {depthMap && status === 'ready' && (
        <div className="pointer-events-none absolute right-[82px] top-4 z-30 flex items-center gap-2 rounded-md border border-white/12 bg-black/70 px-2.5 py-1.5 font-sans text-[9px] uppercase tracking-[0.12em] text-white/65 backdrop-blur-md sm:right-[86px] sm:top-5">
          <span className="text-white/40">Depth</span>
          <span>Near</span>
          <span className="h-1.5 w-16 rounded-full border border-white/15 bg-gradient-to-r from-white to-black" />
          <span>Far</span>
        </div>
      )}

      {status === 'ready' && (
        <figure
          className="pointer-events-none absolute right-4 top-4 z-30 flex w-14 flex-col items-center gap-1 sm:right-5 sm:top-5"
          aria-label="Compass; the red pointer indicates geographic north"
          title="Red pointer indicates north"
        >
          <div className="relative grid size-12 place-items-center rounded-full border border-white/12 bg-black/70 shadow-lg backdrop-blur-md">
            <span className="absolute left-1/2 top-1 h-1 w-px -translate-x-1/2 bg-white/40" />
            <span className="absolute bottom-1 left-1/2 h-1 w-px -translate-x-1/2 bg-white/25" />
            <span className="absolute left-1 top-1/2 h-px w-1 -translate-y-1/2 bg-white/25" />
            <span className="absolute right-1 top-1/2 h-px w-1 -translate-y-1/2 bg-white/25" />
            <div
              ref={compassNeedleRef}
              className="grid size-8 place-items-center will-change-transform"
            >
              <Navigation2 className="size-5 fill-rose-400/70 text-rose-300" />
            </div>
            <span className="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/60 bg-[#071014]" />
          </div>
          <span
            ref={compassLabelRef}
            className="rounded border border-white/10 bg-black/60 px-1.5 py-0.5 font-sans text-[8px] font-medium tracking-[0.08em] text-white/55 backdrop-blur-md"
          >
            N 000°
          </span>
        </figure>
      )}

      <div className="absolute bottom-4 right-4 z-30 flex gap-1.5 sm:bottom-5 sm:right-5">
        <Button
          variant="outline"
          size="icon"
          className="viewer-control"
          aria-label="Toggle depth map"
          aria-pressed={depthMap}
          title="Depth map"
          onClick={toggleDepthMap}
        >
          <Layers3 />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="viewer-control"
          aria-label="Reset camera"
          onClick={resetView}
        >
          <Focus />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="viewer-control"
          aria-label={autoRotate ? 'Pause rotation' : 'Start rotation'}
          aria-pressed={autoRotate}
          onClick={() => setAutoRotate((value) => !value)}
        >
          {autoRotate ? <Pause /> : <Play />}
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="viewer-control"
          aria-label="Toggle wireframe"
          aria-pressed={wireframe}
          onClick={() => setWireframe((value) => !value)}
        >
          <ScanLine />
        </Button>
      </div>
    </div>
  );
}
