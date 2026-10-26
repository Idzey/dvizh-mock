// Коллекция строк в памяти с индексом по id. Любая запись помечает таблицу грязной — персист сохранит её в IndexedDB.
export type Row = Record<string, any>;

type DirtyListener = (table: string) => void;
let onDirty: DirtyListener = () => {};
export const setDirtyListener = (listener: DirtyListener) => {
  onDirty = listener;
};

export class Table<T extends Row = Row> {
  rows: T[] = [];
  private index: Map<string, T> | null = null;

  constructor(readonly name: string) {}

  load(rows: T[]) {
    this.rows = rows;
    this.index = null;
  }

  private ids() {
    if (!this.index) this.index = new Map(this.rows.map((row) => [row.id as string, row]));
    return this.index;
  }

  /** Запись изменили на месте (через `row.field = …`): сообщаем персисту. */
  touch() {
    onDirty(this.name);
  }

  all(): T[] {
    return this.rows;
  }

  get(id: string | null | undefined): T | undefined {
    return id ? this.ids().get(id) : undefined;
  }

  find(predicate: (row: T) => boolean): T | undefined {
    return this.rows.find(predicate);
  }

  filter(predicate: (row: T) => boolean): T[] {
    return this.rows.filter(predicate);
  }

  insert(row: T): T {
    this.rows.push(row);
    this.index?.set(row.id as string, row);
    onDirty(this.name);
    return row;
  }

  update(id: string, patch: Partial<T>): T | undefined {
    const row = this.get(id);
    if (row) {
      Object.assign(row, patch);
      onDirty(this.name);
    }
    return row;
  }

  remove(id: string): boolean {
    const row = this.get(id);
    if (!row) return false;
    this.rows.splice(this.rows.indexOf(row), 1);
    this.index?.delete(id);
    onDirty(this.name);
    return true;
  }

  removeWhere(predicate: (row: T) => boolean): number {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !predicate(row));
    this.index = null;
    if (this.rows.length !== before) onDirty(this.name);
    return before - this.rows.length;
  }
}
