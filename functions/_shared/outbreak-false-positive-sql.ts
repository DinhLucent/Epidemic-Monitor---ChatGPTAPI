/**
 * SQL guard for known Vietnamese lexical false positives.
 *
 * These rows were already classified into outbreak_items, so this read-side
 * filter protects dashboards while the crawler/LLM policy catches up.
 */
export const OUTBREAK_FALSE_POSITIVE_SQL = `
      AND NOT (
        (LOWER(COALESCE(disease, '')) GLOB '*lao*' OR LOWER(COALESCE(disease, '')) GLOB '*tuberculosis*')
        AND (
          LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '')) GLOB '*lao xuống*'
          OR LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '')) GLOB '*lao vào*'
          OR LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '')) GLOB '*lao ra*'
          OR LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '')) GLOB '*lao động*'
          OR LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '')) GLOB '*huân chương lao*'
          OR LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '')) GLOB '*lớn lao*'
          OR LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '')) GLOB '*lao công*'
        )
      )
      AND NOT (
        (LOWER(COALESCE(disease, '')) GLOB '*dại*' OR LOWER(COALESCE(disease, '')) GLOB '*rabies*')
        AND (
          LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '')) GLOB '*cỏ dại*'
          OR LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '')) GLOB '*mọc dại*'
          OR LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '')) GLOB '*cây mọc dại*'
          OR LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '')) GLOB '*thuốc dại*'
          OR LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '')) GLOB '*đại học*'
          OR LOWER(COALESCE(title, '') || ' ' || COALESCE(summary, '')) GLOB '*đại dịch*'
        )
      )`;
