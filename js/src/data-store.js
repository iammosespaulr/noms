// @flow

import Chunk from './chunk.js';
import Ref from './ref.js';
import RefValue from './ref-value.js';
import Struct from './struct.js';
import type {ChunkStore} from './chunk-store.js';
import type {NomsMap} from './map.js';
import type {NomsSet} from './set.js';
import type {valueOrPrimitive} from './value.js';
import {
  Field,
  makeCompoundType,
  makePrimitiveType,
  makeStructType,
  makeType,
  Type,
  stringType,
  boolType,
} from './type.js';
import {Kind} from './noms-kind.js';
import {newMap} from './map.js';
import {newSet} from './set.js';
import {Package, registerPackage} from './package.js';
import {decodeNomsValue} from './decode.js';
import {invariant} from './assert.js';
import {encodeNomsValue} from './encode.js';

type DatasTypes = {
  commitTypeDef: Type,
  datasPackage: Package,
  commitType: Type,
  commitSetType: Type,
  refOfCommitType: Type,
  commitMapType: Type,
};

let emptyCommitMap: Promise<NomsMap<string, RefValue<Struct>>>;
function getEmptyCommitMap(): Promise<NomsMap<string, RefValue<Struct>>> {
  if (!emptyCommitMap) {
    emptyCommitMap = newMap([], getDatasTypes().commitMapType);
  }
  return emptyCommitMap;
}


let datasTypes: DatasTypes;
export function getDatasTypes(): DatasTypes {
  if (!datasTypes) {
    const commitTypeDef = makeStructType('Commit', [
      new Field('value', makePrimitiveType(Kind.Value), false),
      new Field('parents', makeCompoundType(Kind.Set,
        makeCompoundType(Kind.Ref, makeType(new Ref(), 0))), false),
    ], []);

    const datasPackage = new Package([commitTypeDef], []);
    registerPackage(datasPackage);

    const commitType = makeType(datasPackage.ref, 0);
    const refOfCommitType = makeCompoundType(Kind.Ref, commitType);
    const commitSetType = makeCompoundType(Kind.Set, refOfCommitType);
    const commitMapType = makeCompoundType(Kind.Map, makePrimitiveType(Kind.String),
                                                     refOfCommitType);
    datasTypes = {
      commitTypeDef,
      datasPackage,
      commitType,
      refOfCommitType,
      commitSetType,
      commitMapType,
    };
  }

  return datasTypes;
}

interface Cache<T> {  // eslint-disable-line no-undef
  entry(ref: Ref): ?CacheEntry<T>;  // eslint-disable-line no-undef
  get(ref: Ref): ?T;  // eslint-disable-line no-undef
  add(ref: Ref, size: number, value: T): void;  // eslint-disable-line no-undef
}

export default class DataStore {
  _cs: ChunkStore;
  _datasets: Promise<NomsMap<string, RefValue<Struct>>>;
  _valueCache: Cache<Promise<?valueOrPrimitive>>;

  constructor(cs: ChunkStore, cacheSize: number = 0) {
    this._cs = cs;
    this._datasets = this._datasetsFromRootRef(cs.getRoot());
    this._valueCache = cacheSize > 0 ? new SizeCache(cacheSize) : new NoopCache();
  }

  _datasetsFromRootRef(rootRef: Promise<Ref>): Promise<NomsMap<string, RefValue<Struct>>> {
    return rootRef.then(rootRef => {
      if (rootRef.isEmpty()) {
        return getEmptyCommitMap();
      }

      return this.readValue(rootRef);
    });
  }

  head(datasetID: string): Promise<?Struct> {
    return this._datasets.then(
      datasets => datasets.get(datasetID).then(commitRef =>
          commitRef ? this.readValue(commitRef.targetRef) : null));
  }

  datasets(): Promise<NomsMap<string, RefValue<Struct>>> {
    return this._datasets;
  }

  async _descendsFrom(commit: Struct, currentHeadRef: RefValue<Struct>): Promise<boolean> {
    let ancestors = commit.get('parents');
    while (!(await ancestors.has(currentHeadRef))) {
      if (ancestors.isEmpty()) {
        return false;
      }
      ancestors = await getAncestors(ancestors, this);
    }
    return true;
  }

  async readValue(ref: Ref): Promise<any> {
    const entry = this._valueCache.entry(ref);
    if (entry) {
      return entry.value;
    }
    const chunk: Chunk = await this._cs.get(ref);
    if (chunk.isEmpty()) {
      this._valueCache.add(ref, 0, Promise.resolve(null));
      return null;
    }

    const p = decodeNomsValue(chunk, this);
    this._valueCache.add(ref, chunk.data.length, p);
    return p;
  }

  writeValue(v: any, t: ?Type = undefined): Ref {
    if (!t) {
      switch (typeof v) {
        case 'string':
          t = stringType;
          break;
        case 'boolean':
          t = boolType;
          break;
        case 'object':
          t = v.type;
          break;
        default:
          throw new Error(`type parameter is required for ${typeof v}`);
      }
      invariant(t);
    }
    const chunk = encodeNomsValue(v, t, this);
    invariant(!chunk.isEmpty());
    const {ref} = chunk;
    const entry = this._valueCache.entry(ref);
    if (entry && entry.present) {
      return ref;
    }
    this._cs.put(chunk);
    this._valueCache.add(ref, chunk.data.length, Promise.resolve(v));
    return ref;
  }

  async commit(datasetId: string, commit: Struct): Promise<DataStore> {
    const currentRootRefP = this._cs.getRoot();
    const datasetsP = this._datasetsFromRootRef(currentRootRefP);
    let currentDatasets = await (datasetsP:Promise<NomsMap>);
    const currentRootRef = await currentRootRefP;
    const types = getDatasTypes();
    const commitRef = new RefValue(this.writeValue(commit), types.refOfCommitType);

    if (!currentRootRef.isEmpty()) {
      const currentHeadRef = await currentDatasets.get(datasetId);
      if (currentHeadRef) {
        if (commitRef.equals(currentHeadRef)) {
          return this;
        }
        if (!await this._descendsFrom(commit, currentHeadRef)) {
          throw new Error('Merge needed');
        }
      }
    }

    currentDatasets = await currentDatasets.set(datasetId, commitRef);
    const newRootRef = this.writeValue(currentDatasets);
    if (await this._cs.updateRoot(newRootRef, currentRootRef)) {
      return new DataStore(this._cs);
    }

    throw new Error('Optimistic lock failed');
  }
}

async function getAncestors(commits: NomsSet<RefValue<Struct>>, store: DataStore):
    Promise<NomsSet<RefValue<Struct>>> {
  let ancestors = await newSet([], getDatasTypes().commitSetType);
  await commits.map(async (commitRef) => {
    const commit = await store.readValue(commitRef.targetRef);
    await commit.get('parents').map(async (ref) => ancestors = await ancestors.insert(ref));
  });
  return ancestors;
}

export function newCommit(value: valueOrPrimitive, parents: Array<Ref> = []):
    Promise<Struct> {
  const types = getDatasTypes();
  const parentRefs = parents.map(r => new RefValue(r, types.refOfCommitType));
  return newSet(parentRefs, types.commitSetType).then(parents =>
      new Struct(types.commitType, types.commitTypeDef, {value,parents}));
}

class CacheEntry<T> {
  size: number;
  value: ?T;

  constructor(size: number, value: ?T) {
    this.size = size;
    this.value = value;
  }

  get present(): boolean {
    return this.value !== null;
  }
}

/**
 * This uses a Map as an LRU cache. It uses the behavior that iteration of keys in a Map is done in
 * insertion order and any time a value is checked it is taken out and reinserted which puts it last
 * in the iteration.
 */
class SizeCache<T> {
  _size: number;
  _maxSize: number;
  _cache: Map<string, CacheEntry<T>>;

  constructor(size: number) {
    this._maxSize = size;
    this._cache = new Map();
    this._size = 0;
  }

  entry(ref: Ref): ?CacheEntry {
    const key = ref.toString();
    const entry = this._cache.get(key);
    if (!entry) {
      return undefined;
    }
    this._cache.delete(key);
    this._cache.set(key, entry);
    return entry;
  }

  get(ref: Ref): ?T {
    const entry = this.entry(ref);
    return entry ? entry.value : undefined;
  }

  add(ref: Ref, size: number, value: ?T) {
    const key = ref.toString();
    if (this._cache.has(key)) {
      this._cache.delete(key);
    } else {
      this._size += size;
    }
    this._cache.set(key, new CacheEntry(size, value));

    if (this._size > this._maxSize) {
      for (const [key, {size}] of this._cache) {
        if (this._size <= this._maxSize) {
          break;
        }
        this._cache.delete(key);
        this._size -= size;
      }
    }
  }
}

class NoopCache<T> {
  entry(ref: Ref): ?CacheEntry {}  // eslint-disable-line no-unused-vars

  get(ref: Ref): ?T {}  // eslint-disable-line no-unused-vars

  add(ref: Ref, size: number, value: T) {}  // eslint-disable-line no-unused-vars
}
