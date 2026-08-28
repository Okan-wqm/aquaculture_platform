[
  .[]
  | select(
      .name == $context
      and .head_sha == $head_sha
      and .app.slug == "github-actions"
      and .app.id == $app_id
      and (.details_url | type) == "string"
      and (.details_url | startswith($details_prefix))
    )
  | if (.created_at | type) != "string" then
      error("matching required check has no creation timestamp")
    elif ((.created_at | fromdateiso8601) <= ($merged_at | fromdateiso8601)) then
      .
    else
      empty
    end
] as $matches
| if ($matches | length) == 0 then
    error("required check evidence is missing as of merge")
  else
    ($matches | sort_by([(.created_at | fromdateiso8601), .id]) | last) as $effective
    | if (
        $effective.status == "completed"
        and $effective.conclusion == "success"
        and $effective.started_at != null
        and (
          ($effective.started_at | fromdateiso8601)
          <= ($merged_at | fromdateiso8601)
        )
        and $effective.completed_at != null
        and (
          ($effective.completed_at | fromdateiso8601)
          <= ($merged_at | fromdateiso8601)
        )
      ) then
        $effective
        | {
            name,
            id,
            app_id: .app.id,
            head_sha,
            status,
            conclusion,
            created_at,
            started_at,
            completed_at,
            details_url
          }
      else
        error("effective latest required check is not a completed success as of merge")
      end
  end
