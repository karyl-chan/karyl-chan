/**
 * Creates the tables the behavior admin routes read and write — not
 * sequelize.sync(). A test file's imports register every model they
 * reach (18 to 32), a full sync is one serial SQLite round trip per
 * DROP, CREATE and index, and under full-suite CPU load each round trip
 * waits on the scheduler, which is what pushed these beforeAll hooks
 * toward their 10s timeout (#181, #235).
 */
import { AdminAuditLog } from "../src/modules/admin/models/admin-audit-log.model.js";
import { BehaviorCommand } from "../src/modules/behavior/models/behavior-command.model.js";
import { BehaviorDefinition } from "../src/modules/behavior/models/behavior-definition.model.js";
import { BehaviorDelivery } from "../src/modules/behavior/models/behavior-delivery.model.js";
import { BehaviorDmAllowlist } from "../src/modules/behavior/models/behavior-dm-allowlist.model.js";
import { BehaviorDmLog } from "../src/modules/behavior/models/behavior-dm-log.model.js";
import { BehaviorGroupMember } from "../src/modules/behavior/models/behavior-group-member.model.js";
import { BehaviorPluginAction } from "../src/modules/behavior/models/behavior-plugin-action.model.js";
import { BehaviorStat } from "../src/modules/behavior/models/behavior-stats.model.js";
import { BehaviorWebhookAction } from "../src/modules/behavior/models/behavior-webhook-action.model.js";
import { Service } from "../src/modules/behavior/models/service.model.js";
import { ReconcilerOwnedCommand } from "../src/modules/command-system/models/reconciler-owned-command.model.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";

export async function syncBehaviorRouteTables(): Promise<void> {
  for (const model of [
    Service,
    BehaviorCommand,
    BehaviorDefinition,
    BehaviorWebhookAction,
    BehaviorPluginAction,
    BehaviorDmAllowlist,
    BehaviorGroupMember,
    BehaviorDmLog,
    BehaviorStat,
    BehaviorDelivery,
    // the command namespace and registration read these
    PluginCommand,
    ReconcilerOwnedCommand,
    AdminAuditLog,
  ]) {
    await model.sync({ force: true });
  }
}
