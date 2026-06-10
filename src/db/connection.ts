/**
 * MongoDB Connection Management
 * Handles connection lifecycle for agentside
 */

import mongoose from 'mongoose';
import { loggers } from '../utils';

const log = loggers.db || console;

/**
 * MongoDB connection options
 */
interface iMongoDBOptions {
  uri: string;
  maxPoolSize?: number;
  minPoolSize?: number;
  serverSelectionTimeoutMS?: number;
  heartbeatFrequencyMS?: number;
}

/**
 * Connection state
 */
let isConnected = false;
let connectionPromise: Promise<typeof mongoose> | null = null;

/**
 * Connect to MongoDB
 * Returns existing connection if already connected
 */
export async function connectMongoDB(options: iMongoDBOptions): Promise<typeof mongoose> {
  // Return existing connection if connected
  if (isConnected && mongoose.connection.readyState === 1) {
    log.info?.('MongoDB already connected');
    return mongoose;
  }

  // Return pending connection if in progress
  if (connectionPromise) {
    return connectionPromise;
  }

  const { uri, maxPoolSize = 10, minPoolSize = 2, serverSelectionTimeoutMS = 5000, heartbeatFrequencyMS = 10000 } = options;

  connectionPromise = mongoose.connect(uri, {
    maxPoolSize,
    minPoolSize,
    serverSelectionTimeoutMS,
    heartbeatFrequencyMS,
  });

  try {
    await connectionPromise;
    isConnected = true;

    // Set up event handlers
    mongoose.connection.on('connected', () => {
      log.info?.('MongoDB connected successfully');
    });

    mongoose.connection.on('error', (error: Error) => {
      log.error?.('MongoDB connection error', { error: error.message });
    });

    mongoose.connection.on('disconnected', () => {
      log.warn?.('MongoDB disconnected');
      isConnected = false;
    });

    mongoose.connection.on('reconnected', () => {
      log.info?.('MongoDB reconnected');
      isConnected = true;
    });

    log.info?.('MongoDB connection established', {
      dbName: mongoose.connection.db?.databaseName,
      host: mongoose.connection.host,
    });

    return mongoose;
  } catch (error) {
    connectionPromise = null;
    isConnected = false;
    log.error?.('Failed to connect to MongoDB', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Disconnect from MongoDB
 * Graceful shutdown
 */
export async function disconnectMongoDB(): Promise<void> {
  if (!isConnected && mongoose.connection.readyState === 0) {
    log.info?.('MongoDB already disconnected');
    return;
  }

  try {
    await mongoose.disconnect();
    isConnected = false;
    connectionPromise = null;
    log.info?.('MongoDB disconnected successfully');
  } catch (error) {
    log.error?.('Error disconnecting from MongoDB', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Get connection status info
 */
export function getMongoDBStatus(): {
  connected: boolean;
  readyState: number;
  host?: string;
  dbName?: string;
} {
  return {
    connected: isConnected,
    readyState: mongoose.connection.readyState,
    host: mongoose.connection.host,
    dbName: mongoose.connection.db?.databaseName,
  };
}
