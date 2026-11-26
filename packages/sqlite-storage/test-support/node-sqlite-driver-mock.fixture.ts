import { nodeSqliteDriver } from "./node-sqlite-driver.fixture.js";

/** Stands in for the Bun driver module when tests run on Node. */
export const bunSqliteDriver = nodeSqliteDriver;
