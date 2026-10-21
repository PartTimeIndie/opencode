import type { DatabaseMigration } from "../migration"

const SUMMARY_DIFF_PATCH_BUDGET_BYTES = 2 * 1024 * 1024

export default {
  id: "20260830090000_bound_summary_diff_patches",
  up(tx) {
    // New snapshots enforce this aggregate budget before persistence. For legacy
    // rows, retain the complete diff inventory and remove only historical patches.
    return tx.run(`
      UPDATE \`session\` AS target
      SET \`summary_diffs\` = (
        SELECT json_group_array(json(json_remove(diff.value, '$.patch')))
        FROM json_each(
          CASE
            WHEN json_valid(target.\`summary_diffs\`) AND json_type(target.\`summary_diffs\`) = 'array'
            THEN target.\`summary_diffs\`
            ELSE '[]'
          END
        ) AS diff
      )
      WHERE target.\`summary_diffs\` IS NOT NULL
        AND CASE
          WHEN json_valid(target.\`summary_diffs\`)
          THEN json_type(target.\`summary_diffs\`) = 'array'
          ELSE 0
        END
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(
            CASE
              WHEN json_valid(target.\`summary_diffs\`) AND json_type(target.\`summary_diffs\`) = 'array'
              THEN target.\`summary_diffs\`
              ELSE '[]'
            END
          ) AS diff
          WHERE diff.type <> 'object'
        )
        AND (
          SELECT coalesce(sum(
            CASE
              WHEN diff.type = 'object' AND json_type(diff.value, '$.patch') = 'text'
              THEN length(CAST(json_extract(diff.value, '$.patch') AS BLOB))
              ELSE 0
            END
          ), 0)
          FROM json_each(
            CASE
              WHEN json_valid(target.\`summary_diffs\`) AND json_type(target.\`summary_diffs\`) = 'array'
              THEN target.\`summary_diffs\`
              ELSE '[]'
            END
          ) AS diff
        ) > ${SUMMARY_DIFF_PATCH_BUDGET_BYTES}
    `)
  },
} satisfies DatabaseMigration.Migration
