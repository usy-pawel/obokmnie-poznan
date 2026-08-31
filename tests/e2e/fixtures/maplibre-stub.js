(() => {
  const calls = {
    easeTo: [],
    fitBounds: [],
    flyTo: [],
    resize: 0,
  };
  const generalListeners = new Map();
  const layerListeners = new Map();
  const sources = new Map();
  const layers = new Map();

  class Bounds {
    constructor(southWest, northEast) {
      this.west = southWest[0];
      this.south = southWest[1];
      this.east = northEast[0];
      this.north = northEast[1];
    }

    extend(point) {
      this.west = Math.min(this.west, point[0]);
      this.south = Math.min(this.south, point[1]);
      this.east = Math.max(this.east, point[0]);
      this.north = Math.max(this.north, point[1]);
      return this;
    }

    toArray() {
      return [[this.west, this.south], [this.east, this.north]];
    }
  }

  class MapStub {
    constructor(options) {
      this.zoom = options.zoom;
      this.center = options.center;
      this.container = typeof options.container === 'string'
        ? document.getElementById(options.container)
        : options.container;
      this.canvas = document.createElement('canvas');
      this.canvas.dataset.mapReady = 'true';
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.container.append(this.canvas);
      window.setTimeout(() => {
        this.emit('load');
        this.emit('styledata');
      }, 0);
    }

    on(eventName, layerOrHandler, maybeHandler) {
      if (typeof layerOrHandler === 'function') {
        const listeners = generalListeners.get(eventName) || [];
        listeners.push(layerOrHandler);
        generalListeners.set(eventName, listeners);
      } else {
        layerListeners.set(`${eventName}:${layerOrHandler}`, maybeHandler);
      }
      return this;
    }

    emit(eventName, payload = {}) {
      for (const listener of generalListeners.get(eventName) || []) listener(payload);
    }

    addControl() {}

    getStyle() {
      return { layers: [{ id: 'labels', type: 'symbol' }] };
    }

    addSource(id, definition) {
      const source = {
        data: definition.data || null,
        setData(data) { this.data = data; },
      };
      sources.set(id, source);
    }

    getSource(id) {
      return sources.get(id);
    }

    addLayer(layer) {
      layers.set(layer.id, layer);
    }

    getLayer(id) {
      return layers.get(id);
    }

    setLayoutProperty() {}

    getCanvas() {
      return this.canvas;
    }

    getZoom() {
      return this.zoom;
    }

    getBounds() {
      return {
        getWest: () => 18,
        getSouth: () => 50,
        getEast: () => 23,
        getNorth: () => 54,
      };
    }

    cameraForBounds(bounds) {
      const raw = bounds instanceof Bounds ? bounds.toArray() : bounds;
      return {
        center: [
          (raw[0][0] + raw[1][0]) / 2,
          (raw[0][1] + raw[1][1]) / 2,
        ],
        zoom: 7,
      };
    }

    easeTo(options) {
      calls.easeTo.push(structuredClone(options));
      if (options.center) this.center = options.center;
      if (Number.isFinite(options.zoom)) this.zoom = options.zoom;
      window.setTimeout(() => this.emit('moveend'), 0);
    }

    fitBounds(bounds, options = {}) {
      calls.fitBounds.push({ bounds: bounds instanceof Bounds ? bounds.toArray() : bounds, options: structuredClone(options) });
      this.zoom = Math.min(options.maxZoom || 17, 17);
      window.setTimeout(() => this.emit('moveend'), 0);
    }

    flyTo(options) {
      calls.flyTo.push(structuredClone(options));
      if (options.center) this.center = options.center;
      if (Number.isFinite(options.zoom)) this.zoom = options.zoom;
      window.setTimeout(() => this.emit('moveend'), 0);
    }

    resize() {
      calls.resize += 1;
      this.canvas.dataset.resizeCount = String(calls.resize);
    }
  }

  window.maplibregl = {
    Map: MapStub,
    NavigationControl: class {},
    AttributionControl: class {},
    LngLatBounds: Bounds,
  };
  window.__mapTest = {
    calls,
    sourceData: (id) => sources.get(id)?.data || null,
    triggerLayer(eventName, layerId, feature) {
      layerListeners.get(`${eventName}:${layerId}`)?.({ features: [feature] });
    },
  };
})();
