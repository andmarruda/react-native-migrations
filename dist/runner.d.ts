import type { AppliedMigration, MigrationDefinition, MigrationHealthReport, MigrationExecutionResult, MigrationRunnerOptions, RollbackPlanItem, RollbackExecutionResult } from "./types";
export declare class MigrationRunner {
    private readonly db;
    private readonly catalog;
    private readonly readSqlFile;
    private readonly tableName;
    private readonly now;
    private readonly logger;
    private readonly calculateChecksum;
    private readonly integrityMode;
    constructor(options: MigrationRunnerOptions);
    migrate(): Promise<MigrationExecutionResult>;
    rollbackLastBatch(): Promise<RollbackExecutionResult>;
    planRollbackLastBatch(): Promise<RollbackPlanItem[]>;
    status(): Promise<{
        applied: AppliedMigration[];
        pending: MigrationDefinition[];
    }>;
    healthCheck(): Promise<MigrationHealthReport>;
    private createContext;
    private ensureRepository;
    private getAppliedMigrations;
    private getAppliedMigrationsByBatch;
    private getLastBatchNumber;
    private recordMigration;
    private deleteMigrationRecord;
    private ensureRepositoryColumn;
    private buildRollbackBlockReason;
    private runRepositoryPhase;
    private runHook;
    private runSqlFile;
    private runSqlText;
    private runPhase;
    private buildPhaseErrorMessage;
    private log;
    private assertIntegrity;
}
