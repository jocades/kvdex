import type { Collection } from "./collection.ts"
import { IndexableCollection } from "./indexable_collection.ts"
import type {
  AtomicCheck,
  AtomicMutation,
  CollectionSelector,
  IndexDataEntry,
  KvId,
  KvValue,
  Model,
  Operations,
  Schema,
} from "./types.ts"
import {
  extendKey,
  generateId,
  getDocumentId,
  keyEq,
} from "./utils.internal.ts"

// AtomicBuilder class
export class AtomicBuilder<
  const TSchema extends Schema,
  const TValue extends KvValue,
  const TCollection extends Collection<TValue>,
> {
  private kv: Deno.Kv
  private schema: TSchema
  private operations: Operations
  private collection: TCollection

  /**
   * Create a new AtomicBuilder for building and executing atomic operations.
   *
   * @param kv - The Deno KV instance to be used.
   * @param schema - The database schema containing all accessible collections.
   * @param collection - The collection currently in context for building atomic operations.
   * @param operations - List of prepared operations from previous instance.
   */
  constructor(
    kv: Deno.Kv,
    schema: TSchema,
    collection: TCollection,
    operations?: Operations,
  ) {
    this.kv = kv
    this.schema = schema

    this.operations = operations ?? {
      atomicFns: [],
      prepareDeleteFns: [],
      indexDeleteCollectionKeys: [],
      indexAddCollectionKeys: [],
    }

    this.collection = collection
  }

  /**
   * Select a new collection context.
   *
   * @param selector - Selector function for selecting a new collection from the database schema.
   * @returns A new AtomicBuilder instance.
   */
  select<const TValue extends KvValue>(
    selector: CollectionSelector<TSchema, TValue, Collection<TValue>>,
  ) {
    return new AtomicBuilder(
      this.kv,
      this.schema,
      selector(this.schema),
      this.operations,
    )
  }

  /**
   * Add a new document to the KV store with a randomely generated id.
   *
   * @param data - Document data to be added.
   * @returns Current AtomicBuilder instance.
   */
  add(data: TValue) {
    const collectionIdKey = this.collection.collectionIdKey
    const id = generateId()
    const idKey = extendKey(collectionIdKey, id)

    this.operations.atomicFns.push((op) =>
      op.check({ key: idKey, versionstamp: null }).set(idKey, data)
    )

    if (this.collection instanceof IndexableCollection) {
      const primaryCollectionIndexKey =
        this.collection.primaryCollectionIndexKey
      const secondaryCollectionIndexKey =
        this.collection.secondaryCollectionIndexKey
      const primaryIndexList = this.collection.primaryIndexList
      const secondaryIndexList = this.collection.secondaryIndexList
      const _data = data as Model

      this.operations.indexAddCollectionKeys.push(collectionIdKey)

      primaryIndexList.forEach((index) => {
        const indexValue = _data[index] as KvId | undefined
        if (typeof indexValue === "undefined") return

        const indexKey = extendKey(primaryCollectionIndexKey, index, indexValue)
        const indexEntry: IndexDataEntry<typeof _data> = {
          ..._data,
          __id__: id,
        }
        this.operations.atomicFns.push(
          (op) =>
            op.set(indexKey, indexEntry).check({
              key: indexKey,
              versionstamp: null,
            }),
        )
      })

      secondaryIndexList.forEach((index) => {
        const indexValue = _data[index] as KvId | undefined
        if (typeof indexValue === "undefined") return

        const indexKey = extendKey(
          secondaryCollectionIndexKey,
          index,
          indexValue,
          id,
        )
        this.operations.atomicFns.push(
          (op) =>
            op.set(indexKey, data).check({ key: indexKey, versionstamp: null }),
        )
      })
    }

    return this
  }

  /**
   * Adds a new document to the KV store with the given id.
   *
   * @param id - Id of the document to be added.
   * @param data - Document data to be added.
   * @returns Current AtomicBuilder instance.
   */
  set(id: KvId, data: TValue) {
    const collectionKey = this.collection.collectionIdKey
    const idKey = extendKey(collectionKey, id)

    this.operations.atomicFns.push((op) =>
      op.check({ key: idKey, versionstamp: null }).set(idKey, data)
    )

    if (this.collection instanceof IndexableCollection) {
      const primaryCollectionIndexKey =
        this.collection.primaryCollectionIndexKey
      const secondaryCollectionIndexKey =
        this.collection.secondaryCollectionIndexKey
      const primaryIndexList = this.collection.primaryIndexList
      const secondaryIndexList = this.collection.secondaryIndexList
      const _data = data as Model

      this.operations.indexAddCollectionKeys.push(collectionKey)

      primaryIndexList.forEach((index) => {
        const indexValue = _data[index] as KvId | undefined
        if (typeof indexValue === "undefined") return

        const indexKey = extendKey(primaryCollectionIndexKey, index, indexValue)
        const indexEntry: IndexDataEntry<typeof _data> = {
          ..._data,
          __id__: id,
        }
        this.operations.atomicFns.push(
          (op) =>
            op.set(indexKey, indexEntry).check({
              key: indexKey,
              versionstamp: null,
            }),
        )
      })

      secondaryIndexList.forEach((index) => {
        const indexValue = _data[index] as KvId | undefined
        if (typeof indexValue === "undefined") return

        const indexKey = extendKey(
          secondaryCollectionIndexKey,
          index,
          indexValue,
          id,
        )
        this.operations.atomicFns.push(
          (op) =>
            op.set(indexKey, data).check({ key: indexKey, versionstamp: null }),
        )
      })
    }

    return this
  }

  /**
   * Deletes a document from the KV store with the given id.
   *
   * @param id - Id of document to be deleted.
   * @returns Current AtomicBuilder instance.
   */
  delete(id: KvId) {
    const collectionKey = this.collection.collectionIdKey
    const idKey = extendKey(collectionKey, id)

    this.operations.atomicFns.push((op) => op.delete(idKey))

    if (this.collection instanceof IndexableCollection) {
      const primaryCollectionIndexKey =
        this.collection.primaryCollectionIndexKey
      const secondaryCollectionIndexKey =
        this.collection.secondaryCollectionIndexKey
      const primaryIndexList = this.collection.primaryIndexList
      const secondaryIndexList = this.collection.secondaryIndexList

      this.operations.indexDeleteCollectionKeys.push(collectionKey)

      this.operations.prepareDeleteFns.push(async (kv) => {
        const doc = await kv.get<Model>(idKey)

        return {
          id,
          data: doc.value ?? {},
          primaryCollectionIndexKey,
          secondaryCollectionIndexKey,
          primaryIndexList,
          secondaryIndexList,
        }
      })
    }

    return this
  }

  /**
   * Check if documents have been changed since a specific versionstamp.
   *
   * @param atomicChecks - AtomicCheck objects containing a document id and versionstamp.
   * @returns Current AtomicBuilder instance.
   */
  check(...atomicChecks: AtomicCheck<TValue>[]) {
    const checks: Deno.AtomicCheck[] = atomicChecks.map(
      ({ id, versionstamp }) => {
        const key = extendKey(this.collection.collectionIdKey, id)
        return {
          key,
          versionstamp,
        }
      },
    )

    this.operations.atomicFns.push((op) => op.check(...checks))
    return this
  }

  /**
   * Adds the given value to the value of the document with the given id.
   * Sum only works for documents of type Deno.KvU64 and will throw an error for documents of any other type.
   *
   * @param id - Id of document that contains the value to be updated.
   * @param value - The value to add to the document value.
   * @returns Current AtomicBuilder instance.
   */
  sum(id: KvId, value: bigint) {
    const idKey = extendKey(this.collection.collectionIdKey, id)
    this.operations.atomicFns.push((op) => op.sum(idKey, value))
    return this
  }

  /**
   * Specifies atomic mutations to be formed on documents.
   *
   * @param mutations - Atomic mutations to be performed.
   * @returns Current AtomicBuilder instance.
   */
  mutate(...mutations: AtomicMutation<TValue>[]) {
    const kvMutations: Deno.KvMutation[] = mutations.map(({ id, ...rest }) => {
      const idKey = extendKey(this.collection.collectionIdKey, id)
      return {
        key: idKey,
        ...rest,
      }
    })

    this.operations.atomicFns.push((op) => op.mutate(...kvMutations))

    kvMutations.forEach((mut) => {
      if (mut.type === "set") {
        this.operations.atomicFns.push((op) =>
          op.check({
            key: mut.key,
            versionstamp: null,
          })
        )
      }

      if (this.collection instanceof IndexableCollection) {
        const collectionIdKey = this.collection.collectionIdKey
        const primaryCollectionIndexKey =
          this.collection.primaryCollectionIndexKey
        const secondaryCollectionIndexKey =
          this.collection.secondaryCollectionIndexKey
        const primaryIndexList = this.collection.primaryIndexList
        const secondaryIndexList = this.collection.secondaryIndexList
        const id = getDocumentId(mut.key)
        if (typeof id === "undefined") return

        if (mut.type === "set") {
          this.operations.indexAddCollectionKeys.push(collectionIdKey)

          primaryIndexList.forEach((index) => {
            if (typeof id === "undefined") return

            const data = mut.value as Model
            const indexValue = data[index] as KvId | undefined
            if (typeof indexValue === "undefined") return

            const indexKey = extendKey(
              primaryCollectionIndexKey,
              index,
              indexValue,
            )
            const indexEntry: IndexDataEntry<typeof data> = {
              ...data,
              __id__: id,
            }
            this.operations.atomicFns.push(
              (op) =>
                op.set(indexKey, indexEntry).check({
                  key: indexKey,
                  versionstamp: null,
                }),
            )
          })

          secondaryIndexList.forEach((index) => {
            if (typeof id === "undefined") return

            const data = mut.value as Model
            const indexValue = data[index] as KvId | undefined
            if (typeof indexValue === "undefined") return

            const indexKey = extendKey(
              secondaryCollectionIndexKey,
              index,
              indexValue,
              id,
            )
            this.operations.atomicFns.push(
              (op) =>
                op.set(indexKey, data).check({
                  key: indexKey,
                  versionstamp: null,
                }),
            )
          })
        }

        if (mut.type === "delete") {
          this.operations.indexDeleteCollectionKeys.push(collectionIdKey)

          this.operations.prepareDeleteFns.push(async (kv) => {
            const doc = await kv.get<Model>(mut.key)
            return {
              id,
              data: doc.value ?? {},
              primaryCollectionIndexKey,
              secondaryCollectionIndexKey,
              primaryIndexList,
              secondaryIndexList,
            }
          })
        }
      }
    })

    return this
  }

  /**
   * Executes the built atomic operation.
   * Will always fail if trying to delete and add/set to the same indexable collection in the same operation.
   *
   * @returns A promise that resolves to a Deno.KvCommitResult if the operation is successful, or Deno.KvCommitError if not.
   */
  async commit(): Promise<Deno.KvCommitResult | Deno.KvCommitError> {
    // Check for overlapping keys
    if (
      this.operations.indexAddCollectionKeys
        .some((addKey) =>
          this.operations.indexDeleteCollectionKeys
            .some((deleteKey) => keyEq(addKey, deleteKey))
        )
    ) {
      return {
        ok: false,
      }
    }

    // Prepare delete ops
    const preparedIndexDeletes = await Promise.all(
      this.operations.prepareDeleteFns.map((fn) => fn(this.kv)),
    )

    // Perform atomic operation
    const atomicOperation = this.operations.atomicFns.reduce(
      (op, opFn) => opFn(op),
      this.kv.atomic(),
    )
    const commitResult = await atomicOperation.commit()

    // If successful commit, perform delete ops
    if (commitResult.ok) {
      await Promise.all(preparedIndexDeletes.map(async (preparedDelete) => {
        const {
          id,
          data,
          primaryCollectionIndexKey,
          secondaryCollectionIndexKey,
          primaryIndexList,
          secondaryIndexList,
        } = preparedDelete

        let atomic = this.kv.atomic()

        primaryIndexList.forEach((index) => {
          const indexValue = data[index] as KvId | undefined
          if (typeof indexValue === "undefined") return

          const indexKey = extendKey(
            primaryCollectionIndexKey,
            index,
            indexValue,
          )
          atomic = atomic.delete(indexKey)
        })

        secondaryIndexList.forEach((index) => {
          const indexValue = data[index] as KvId | undefined
          if (typeof indexValue === "undefined") return

          const indexKey = extendKey(
            secondaryCollectionIndexKey,
            index,
            indexValue,
            id,
          )
          atomic = atomic.delete(indexKey)
        })

        await atomic.commit()
      }))
    }

    // Return commit result
    return commitResult
  }
}
