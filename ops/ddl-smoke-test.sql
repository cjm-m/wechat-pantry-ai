-- =============================================================================
-- ops/draft/schema-rebuild.sql 的冒烟验收（在**空库**上跑，全程事务内，最后 rollback）
-- =============================================================================
-- 用法：
--   docker exec -i pg-test psql -U postgres -d home_test -v ON_ERROR_STOP=1 \
--     -f /tmp/ddl-smoke-test.sql
-- 期望：每行 verdict 全为 PASS；任何 FAIL 都会在最后被汇总列出。
-- 设计取舍：不用临时结果表（切换到 authenticated 后写不进去），逐条打印即可。
-- =============================================================================
\set ON_ERROR_STOP on
\pset pager off
\pset format aligned

\echo ''
\echo '########## T0 结构 ##########'

select 'T0.tables            ' as chk, count(*)::text as val,
       case when count(*) = 12 then 'PASS' else 'FAIL' end as verdict
  from information_schema.tables
 where table_schema = 'public' and table_type = 'BASE TABLE';

select 'T0.functions(public) ' as chk, count(*)::text,
       case when count(*) between 36 and 50 then 'PASS' else 'FAIL' end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public';

select 'T0.security_definer  ' as chk,
       count(*) filter (where p.prosecdef)::text || '/' || count(*)::text,
       case when count(*) filter (where p.prosecdef) >= 28 then 'PASS' else 'FAIL' end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public';

select 'T0.policies          ' as chk, count(*)::text,
       case when count(*) = 19 then 'PASS' else 'FAIL' end
  from pg_policies where schemaname = 'public';

-- 12 张表全开 RLS（9 张原有 + N9 三张）
select 'T0.rls_enabled       ' as chk, count(*)::text || '/12',
       case when count(*) = 12 then 'PASS' else 'FAIL' end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;

select 'T0.roles             ' as chk, string_agg(rolname, ',' order by rolname),
       case when count(*) = 3 then 'PASS' else 'FAIL' end
  from pg_roles where rolname in ('anon', 'authenticated', 'service_role');

-- 六张「客户端零权限」表不得对 anon/authenticated 有任何表级授权
select 'T0.zero_grant_tables ' as chk,
       coalesce(string_agg(table_name || '/' || grantee, ',' order by table_name, grantee), '(none)'),
       case when count(*) = 0 then 'PASS' else 'FAIL' end
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon', 'authenticated')
   and table_name in ('shopping_item', 'dish_request', 'reminder_job',
                      'meal_plan', 'meal_plan_item', 'consumption_log');

-- N9：三张新表的 identity 序列也不得授权（第 7.3 节的「全授」会波及它们）
select 'T0.zero_grant_seq     ' as chk,
       coalesce(string_agg(object_name || '/' || grantee, ',' order by object_name, grantee), '(none)'),
       case when count(*) = 0 then 'PASS' else 'FAIL' end
  from information_schema.role_usage_grants
 where object_schema = 'public' and grantee in ('anon', 'authenticated')
   and object_name in ('meal_plan_id_seq', 'meal_plan_item_id_seq', 'consumption_log_id_seq');

-- N9：内部函数不可被客户端直调（plan_consume_items 收 p_space_id，能删别人冰箱）
select 'T0.internal_fn_exec  ' as chk,
       coalesce(string_agg(p.proname || '/' || r.rolname, ',' order by p.proname, r.rolname), '(none)'),
       case when count(*) = 0 then 'PASS' else 'FAIL' end
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated')) r(rolname)
 where n.nspname = 'public'
   and p.proname in ('plan_consume_items', 'plan_calc_shortage')
   and has_function_privilege(r.rolname, p.oid, 'EXECUTE');


begin;

\echo ''
\echo '########## T1 建家：A 建小家 ##########'
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"wx:test_a","role":"authenticated"}', true) is not null as ok \gset

select 'T1.auth_uid          ' as chk, coalesce(auth.uid(), '(null)'),
       case when auth.uid() = 'wx:test_a' then 'PASS' else 'FAIL' end;

select id as a_space, invite_code as a_code from public.create_space('测试小家') \gset

select 'T1.create_space      ' as chk, 'id=' || coalesce(:'a_space', 'null') || ' code=' || coalesce(:'a_code', 'null'),
       case when :'a_code' ~ '^[A-Z0-9]{6}$' then 'PASS' else 'FAIL' end;

select 'T1.member_count      ' as chk, count(*)::text,
       case when count(*) = 1 then 'PASS' else 'FAIL' end
  from public.couple_member;

-- 一人只能在一个小家：A 再建一个必须失败
do $$
begin
    perform public.create_space('第二个家');
    raise notice 'T1.one_home_only      | 第二个家建成功 | FAIL';
exception when others then
    raise notice 'T1.one_home_only      | 第二次建家被拒: % (%) | PASS', sqlerrm, sqlstate;
end $$;


\echo ''
\echo '########## T2 入家：B 用邀请码加入 ##########'
-- 先验错码：必须用一个还没进家的人，否则会先撞「你已经有小家了」
select set_config('request.jwt.claims', '{"sub":"wx:test_d","role":"authenticated"}', true) is not null as ok \gset
do $$
begin
    perform public.join_space('ZZZZZZ');
    raise notice 'T2.bad_code          | 错码竟然成功 | FAIL';
exception when others then
    raise notice 'T2.bad_code          | 错码被拒: % (%) | PASS', sqlerrm, sqlstate;
end $$;

select set_config('request.jwt.claims', '{"sub":"wx:test_b","role":"authenticated"}', true) is not null as ok \gset
select count(*) as joined from public.join_space(:'a_code') \gset
select 'T2.join_space        ' as chk, 'returned=' || :'joined',
       case when :'joined'::int >= 1 then 'PASS' else 'FAIL' end;

select 'T2.member_count      ' as chk, count(*)::text,
       case when count(*) = 2 then 'PASS' else 'FAIL' end
  from public.couple_member;


\echo ''
\echo '########## T3 食材：A 写、B 可读、owner 不可伪造 ##########'
select set_config('request.jwt.claims', '{"sub":"wx:test_a","role":"authenticated"}', true) is not null as ok \gset
insert into public.ingredient (space_id, name, category, quantity, unit, storage, expire_at)
values (:'a_space'::bigint, '番茄', '蔬菜', '3', '个', '冷藏', current_date + 1);

select 'T3.insert_as_a       ' as chk, count(*)::text,
       case when count(*) = 1 then 'PASS' else 'FAIL' end
  from public.ingredient;

select set_config('request.jwt.claims', '{"sub":"wx:test_b","role":"authenticated"}', true) is not null as ok \gset
select 'T3.partner_sees      ' as chk, count(*)::text,
       case when count(*) = 1 then 'PASS' else 'FAIL' end
  from public.ingredient;

-- 伪造 owner_id：触发器必须复位成真实 auth.uid()
update public.ingredient set owner_id = 'wx:hacker', owner_name = 'hacker' where name = '番茄';
select 'T3.owner_forgery     ' as chk, coalesce(max(owner_id), '(none)'),
       case when max(owner_id) = 'wx:test_a' then 'PASS' else 'FAIL' end
  from public.ingredient;


\echo ''
\echo '########## T4 隔离：C 建自己的家，看不到别人的 ##########'
select set_config('request.jwt.claims', '{"sub":"wx:test_c","role":"authenticated"}', true) is not null as ok \gset
select id as c_space from public.create_space('别人家') \gset
select 'T4.cross_space_leak  ' as chk, count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.ingredient;

select 'T4.c_space           ' as chk, coalesce(:'c_space', 'null'),
       case when :'c_space' <> :'a_space' then 'PASS' else 'FAIL' end;


\echo ''
\echo '########## T5 购物车：零表级权限，只走 cart_* ##########'
do $$
begin
    perform 1 from public.shopping_item limit 1;
    raise notice 'T5.direct_select     | 竟然可直读 | FAIL';
exception when insufficient_privilege then
    raise notice 'T5.direct_select     | 42501 拒绝 | PASS';
end $$;

select set_config('request.jwt.claims', '{"sub":"wx:test_a","role":"authenticated"}', true) is not null as ok \gset
select count(*) as added from public.cart_add('牛奶', 2, '盒', 12.5) \gset
select 'T5.cart_add          ' as chk, 'rows=' || :'added',
       case when :'added'::int = 1 then 'PASS' else 'FAIL' end;

select 'T5.cart_list         ' as chk, count(*)::text,
       case when count(*) = 1 then 'PASS' else 'FAIL' end
  from public.cart_list();

select set_config('request.jwt.claims', '{"sub":"wx:test_c","role":"authenticated"}', true) is not null as ok \gset
select 'T5.cart_isolated     ' as chk, count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.cart_list();


\echo ''
\echo '########## T6 点菜状态机 ##########'
select set_config('request.jwt.claims', '{"sub":"wx:test_a","role":"authenticated"}', true) is not null as ok \gset
select id as d_id from public.dish_create('番茄炒蛋', current_date, 'dinner', '多放点糖') \gset
select 'T6.dish_create       ' as chk, 'id=' || coalesce(:'d_id', 'null'),
       case when :'d_id' is not null then 'PASS' else 'FAIL' end;

select set_config('request.jwt.claims', '{"sub":"wx:test_b","role":"authenticated"}', true) is not null as ok \gset
select count(*) as claimed from public.dish_claim(:'d_id'::bigint) \gset
select 'T6.dish_claim        ' as chk, 'rows=' || :'claimed',
       case when :'claimed'::int = 1 then 'PASS' else 'FAIL' end;

-- A 不能抢 B 已认领的菜
select set_config('request.jwt.claims', '{"sub":"wx:test_a","role":"authenticated"}', true) is not null as ok \gset
select set_config('app.test_d_id', :'d_id', true) is not null as ok \gset
do $$
declare
    v_id bigint := current_setting('app.test_d_id')::bigint;
begin
    perform public.dish_claim(v_id);
    raise notice 'T6.double_claim      | 重复认领成功 | FAIL';
exception when others then
    raise notice 'T6.double_claim      | 被拒: % (%) | PASS', sqlerrm, sqlstate;
end $$;

select set_config('request.jwt.claims', '{"sub":"wx:test_b","role":"authenticated"}', true) is not null as ok \gset
select count(*) as finished from public.dish_finish(:'d_id'::bigint) \gset
select 'T6.dish_finish       ' as chk, 'rows=' || :'finished',
       case when :'finished'::int = 1 then 'PASS' else 'FAIL' end;

select 'T6.final_status      ' as chk, coalesce(string_agg(status, ','), '(none)'),
       case when bool_and(status = 'done') then 'PASS' else 'FAIL' end
  from public.dish_list() where id = :'d_id'::bigint;


\echo ''
\echo '########## T7 站内消息幂等 ##########'
select set_config('request.jwt.claims', '{"sub":"wx:test_a","role":"authenticated"}', true) is not null as ok \gset
select set_config('app.test_a_space', :'a_space', true) is not null as ok \gset
insert into public.notice (space_id, user_id, type, title, dedupe_key)
values (:'a_space'::bigint, 'wx:test_a', 'system', '第一条', 'dedupe-test-1');

do $$
declare
    v_space bigint := current_setting('app.test_a_space')::bigint;
begin
    insert into public.notice (space_id, user_id, type, title, dedupe_key)
    values (v_space, 'wx:test_a', 'system', '重复', 'dedupe-test-1');
    raise notice 'T7.dedupe            | 重复插入成功 | FAIL';
exception when unique_violation then
    raise notice 'T7.dedupe            | 23505 去重生效 | PASS';
end $$;

select 'T7.notice_visible    ' as chk, count(*)::text,
       case when count(*) = 1 then 'PASS' else 'FAIL' end
  from public.notice;


\echo ''
\echo '########## T8 订阅提醒（cron 链路） ##########'
reset role;
select encode(sha256(convert_to('test-token-1234567890', 'UTF8')), 'hex') as h \gset
select set_config('app.reminder_token_sha256', :'h', true) is not null as ok \gset

insert into public.notify_setting (user_id, space_id, wx_openid, enabled, remind_at)
values ('wx:test_a', :'a_space'::bigint, 'openid_test_a', true, '00:00');

select 'T8.reminder_due      ' as chk, count(*)::text,
       case when count(*) = 1 then 'PASS' else 'FAIL' end
  from public.reminder_due('test-token-1234567890');

select 'T8.due_columns       ' as chk,
       (select string_agg(k, ',' order by k) from public.reminder_due('test-token-1234567890') t, jsonb_object_keys(to_jsonb(t)) k),
       case when (select count(*) from public.reminder_due('test-token-1234567890') t, jsonb_object_keys(to_jsonb(t)) k) = 7
            then 'PASS' else 'FAIL' end;

do $$
begin
    perform 1 from public.reminder_due('bad-token-000000000');
    raise notice 'T8.bad_token         | 错令牌竟通过 | FAIL';
exception when sqlstate '28000' then
    raise notice 'T8.bad_token         | 28000 拒绝 | PASS';
end $$;

select 'T8.confirm_sent_on   ' as chk, count(*)::text,
       case when count(*) = 1 then 'PASS' else 'FAIL' end
  from public.reminder_confirm('test-token-1234567890', 'wx:test_a');

select 'T8.due_after_confirm ' as chk, count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.reminder_due('test-token-1234567890');

-- 事件队列（客户端零权限，由 dish_notify 写入）
insert into public.reminder_job (space_id, user_id, kind, title, page, payload, fire_at, dedupe_key)
values (:'a_space'::bigint, 'wx:test_a', 'dish', '该做饭了', '/pages/dishes/dishes',
        '{"dishId":1}'::jsonb, now() - interval '1 minute', 'job-test-1');

select 'T8.jobs              ' as chk, count(*)::text,
       case when count(*) = 1 then 'PASS' else 'FAIL' end
  from public.reminder_jobs('test-token-1234567890');

select 'T8.jobs_columns      ' as chk,
       (select string_agg(k, ',' order by k) from public.reminder_jobs('test-token-1234567890') t, jsonb_object_keys(to_jsonb(t)) k),
       case when (select count(*) from public.reminder_jobs('test-token-1234567890') t, jsonb_object_keys(to_jsonb(t)) k) = 8
            then 'PASS' else 'FAIL' end;

select public.reminder_job_done('test-token-1234567890',
       (select id from public.reminder_job where dedupe_key = 'job-test-1'), 'sent') as jobdone \gset

select 'T8.job_done          ' as chk, :'jobdone',
       case when :'jobdone' = 't' then 'PASS' else 'FAIL' end;


\echo ''
\echo '########## T9 无身份直调必须 28000 ##########'
reset role;
set local role anon;
select set_config('request.jwt.claims', '', true) is not null as ok \gset

do $$
begin
    perform 1 from public.dish_list();
    raise notice 'T9.anon_dish_list    | anon 竟能调 dish_list | FAIL';
exception when sqlstate '28000' then
    raise notice 'T9.anon_dish_list    | 28000 拒绝 | PASS';
end $$;

do $$
begin
    perform 1 from public.cart_list();
    raise notice 'T9.anon_cart_list    | anon 竟能调 cart_list | FAIL';
exception when sqlstate '28000' then
    raise notice 'T9.anon_cart_list    | 28000 拒绝 | PASS';
end $$;

do $$
begin
    perform 1 from public.plan_ensure_week(current_date);
    raise notice 'T9.anon_plan_ensure  | anon 竟能调 plan_ensure_week | FAIL';
exception when sqlstate '28000' then
    raise notice 'T9.anon_plan_ensure  | 28000 拒绝 | PASS';
end $$;

do $$
begin
    perform 1 from public.nutrition_daily(7);
    raise notice 'T9.anon_nutrition    | anon 竟能调 nutrition_daily | FAIL';
exception when sqlstate '28000' then
    raise notice 'T9.anon_nutrition    | 28000 拒绝 | PASS';
end $$;

reset role;


\echo ''
\echo '########## T10 N9 四表闭环 ##########'
-- T10.1 结构：三张表的 CHECK / 部分唯一索引
select 'T10.week_chk         ' as chk,
       case when public.plan_to_monday('2026-11-15') = date '2026-11-09'
             and public.plan_to_monday('2026-11-16') = date '2026-11-16'
             and public.plan_to_monday('1899-12-31') = date '1899-12-25'
            then 'PASS' else 'FAIL' end;

select 'T10.partial_index    ' as chk, indexdef,
       case when indexdef like '%WHERE (status <> %' then 'PASS' else 'FAIL' end
  from pg_indexes
 where schemaname = 'public' and indexname = 'meal_plan_space_week_key';

select 'T10.rpc_definer      ' as chk, count(*)::text || '/10',
       case when count(*) filter (where p.prosecdef) = 10 then 'PASS' else 'FAIL' end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('plan_ensure_week', 'plan_get', 'plan_add_item', 'plan_remove_item',
                     'plan_confirm', 'plan_shortage', 'plan_cook_item', 'plan_cancel',
                     'dish_consume', 'nutrition_daily');

-- T10.2 客户端直读三张新表必须 42501
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"wx:test_a","role":"authenticated"}', true) is not null as ok \gset
do $$
begin
    perform 1 from public.meal_plan limit 1;
    raise notice 'T10.direct_meal_plan | 可直读 | FAIL';
exception when insufficient_privilege then
    raise notice 'T10.direct_meal_plan | 42501 拒绝 | PASS';
end $$;
do $$
begin
    perform 1 from public.consumption_log limit 1;
    raise notice 'T10.direct_log       | 可直读 | FAIL';
exception when insufficient_privilege then
    raise notice 'T10.direct_log       | 42501 拒绝 | PASS';
end $$;

-- T10.3 全流程：ensureWeek → addItem ×2 → confirm（缺料）→ cook（幂等）→ done
select id as plan_id from public.plan_ensure_week(current_date) \gset
select 'T10.ensure_week      ' as chk, coalesce(:'plan_id', 'null'),
       case when :'plan_id' is not null then 'PASS' else 'FAIL' end;

-- 同周再来一次必须返回同一份
select id as plan_id2 from public.plan_ensure_week(current_date) \gset
select 'T10.ensure_idem      ' as chk, :'plan_id' || ' vs ' || :'plan_id2',
       case when :'plan_id' = :'plan_id2' then 'PASS' else 'FAIL' end;

select id as item1 from public.plan_add_item(:'plan_id'::bigint, 0, 'dinner', '番茄炒蛋',
    '[{"name":"番茄","amount":"2 个","from_fridge":true},{"name":"鸡蛋","amount":"3 个","from_fridge":true}]'::jsonb) \gset
select id as item2 from public.plan_add_item(:'plan_id'::bigint, 1, 'dinner', '青椒肉丝',
    '[{"name":"青椒","amount":"2 个","from_fridge":true},{"name":"猪肉","amount":"300g","from_fridge":true}]'::jsonb) \gset
select 'T10.add_item         ' as chk, coalesce(:'item1', 'null') || '/' || coalesce(:'item2', 'null'),
       case when :'item1' is not null and :'item2' is not null then 'PASS' else 'FAIL' end;

-- 库存：番茄有、鸡蛋有、青椒有、猪肉没有（T3 插过番茄）
insert into public.ingredient (space_id, name, category, quantity, unit)
values (:'a_space'::bigint, '鸡蛋', '肉蛋', '4', '个'),
       (:'a_space'::bigint, '青椒', '蔬菜', '2', '个')
on conflict do nothing;

select status as plan_status_after_confirm from public.plan_confirm(:'plan_id'::bigint) \gset
select 'T10.confirm          ' as chk, :'plan_status_after_confirm',
       case when :'plan_status_after_confirm' = 'confirmed' then 'PASS' else 'FAIL' end;

select 'T10.shortage_miss    ' as chk,
       coalesce(string_agg(x ->> 'name', ',' order by x ->> 'name') filter (where x ->> 'level' = 'miss'), '(none)'),
       case when count(*) filter (where x ->> 'level' = 'miss') = 1
             and (array_agg(x ->> 'name') filter (where x ->> 'level' = 'miss'))[1] = '猪肉'
            then 'PASS 只有猪肉缺' else 'FAIL' end
  from public.plan_shortage(:'plan_id'::bigint) p,
       jsonb_array_elements(p.shortage) x;

-- T10.4 幂等：同一 item 连做三次，只有第一次 dup=false
select (public.plan_cook_item(:'item1'::bigint, '[]'::jsonb)) ->> 'dup' as dup1 \gset
select (public.plan_cook_item(:'item1'::bigint, '[]'::jsonb)) ->> 'dup' as dup2 \gset
select (public.plan_cook_item(:'item1'::bigint, '[]'::jsonb)) ->> 'dup' as dup3 \gset
select 'T10.cook_idem        ' as chk, :'dup1' || '/' || :'dup2' || '/' || :'dup3',
       case when :'dup1' = 'false' and :'dup2' = 'true' and :'dup3' = 'true'
            then 'PASS' else 'FAIL' end;

-- T10.5 部分消耗：青椒 removed、鸡蛋 kept
select id as ing_qj from public.ingredient where name = '青椒' and space_id = :'a_space'::bigint \gset
select id as ing_jd from public.ingredient where name = '鸡蛋' and space_id = :'a_space'::bigint \gset
select (public.plan_cook_item(:'item2'::bigint, jsonb_build_array(
            jsonb_build_object('ingredient_id', :'ing_qj'::bigint, 'action', 'removed'),
            jsonb_build_object('ingredient_id', :'ing_jd'::bigint, 'action', 'kept')))) ->> 'dup' as dup4 \gset
select 'T10.partial_consume  ' as chk,
       '青椒=' || (select count(*)::text from public.ingredient where name = '青椒' and space_id = :'a_space'::bigint)
       || ' 鸡蛋=' || (select count(*)::text from public.ingredient where name = '鸡蛋' and space_id = :'a_space'::bigint),
       case when (select count(*) from public.ingredient where name = '青椒' and space_id = :'a_space'::bigint) = 0
             and (select count(*) from public.ingredient where name = '鸡蛋' and space_id = :'a_space'::bigint) = 1
            then 'PASS' else 'FAIL' end;

-- T10.6 全部做完 → plan 自动 done；done 不可取消
select (public.plan_get(:'plan_id'::bigint)) -> 'plan' ->> 'status' as st \gset
select 'T10.auto_done        ' as chk, :'st',
       case when :'st' = 'done' then 'PASS' else 'FAIL' end;

select set_config('app.test_plan_id', :'plan_id', true) is not null as ok \gset
do $$
declare v bigint := current_setting('app.test_plan_id')::bigint;
begin
    perform public.plan_cancel(v);
    raise notice 'T10.done_no_cancel   | done 竟能取消 | FAIL';
exception when others then
    raise notice 'T10.done_no_cancel   | 被拒: % | PASS', sqlerrm;
end $$;

-- T10.6b 已确认的空菜单：允许加菜（历史遗留状态，否则会死锁）
--   真实踩过：早期 plan_confirm 没有「至少 1 道」校验，确认了空计划后
--   加菜被拒、再确认也被拒，只能作废重排。
--   注意：meal_plan 是 RPC-only 表，authenticated 直接 INSERT 会 42501，
--   所以这里要先 reset role 用超级用户造这条异常数据，再切回 authenticated 测。
reset role;
insert into public.meal_plan (space_id, week_start, status, created_by)
values (:'a_space'::bigint, date '2027-03-01', 'confirmed', 'wx:test_a')
returning id as empty_plan \gset
select set_config('app.test_empty_plan', :'empty_plan', true) is not null as ok \gset
set local role authenticated;

-- 必须分两步：同一个 SELECT 里既调 plan_add_item 又调 plan_get 时，
-- PostgreSQL 不保证两个表达式的求值顺序，plan_get 可能先跑（读到 0 个格子）。
select public.plan_add_item(:'empty_plan'::bigint, 0, 'dinner', '空计划补菜', '[]'::jsonb) \gset
select 'T10.empty_plan_add   ' as chk,
       'items=' || jsonb_array_length((public.plan_get(:'empty_plan'::bigint)) -> 'items'),
       -- 不能直接 select meal_plan_item（RPC-only，42501），用 plan_get 读回来数格子
       case when jsonb_array_length((public.plan_get(:'empty_plan'::bigint)) -> 'items') = 1
            then 'PASS 已确认空计划允许加菜' else 'FAIL 加不进去' end;

-- 加完就有菜了，再加第二道必须被拒（否则等于「已确认也能随便改」）
do $$
declare v_plan bigint := current_setting('app.test_empty_plan', true)::bigint;
begin
    perform public.plan_add_item(v_plan, 1, 'dinner', '第二道', '[]'::jsonb);
    raise notice 'T10.empty_plan_lock  | 有菜后还能加 | FAIL';
exception when others then
    raise notice 'T10.empty_plan_lock  | 有菜后被拒: % | PASS', sqlerrm;
end $$;

-- T10.7 缺料判定的 have/maybe/miss 三档（库存「鸡蛋面」，需求「鸡蛋」→ maybe 而非 have）
insert into public.ingredient (space_id, name, category) values (:'a_space'::bigint, '鸡蛋面', '主食');
select id as plan2 from public.plan_ensure_week(current_date + 7) \gset
select id as item3 from public.plan_add_item(:'plan2'::bigint, 0, 'lunch', '测试菜',
    '[{"name":"鸡蛋","from_fridge":true},{"name":"生姜","from_fridge":true}]'::jsonb) \gset
-- 先 confirm（setof 不能当参数用，单独一步）
select count(*) as confirmed2 from public.plan_confirm(:'plan2'::bigint) \gset
select 'T10.shortage_maybe   ' as chk,
       coalesce(string_agg((x ->> 'name') || '=' || (x ->> 'level'), ',' order by x ->> 'name'), '(none)'),
       case when (select count(*) from public.plan_shortage(:'plan2'::bigint) p,
                            jsonb_array_elements(p.shortage) x
                   where x ->> 'level' in ('have', 'maybe', 'miss')) = 2
            then 'PASS 三档语义有效' else 'FAIL' end
  from (select shortage from public.plan_shortage(:'plan2'::bigint)) s,
       jsonb_array_elements(s.shortage) x;

-- T10.8 跨家隔离：C 操作 A 的 plan / item 必须被拒
select set_config('request.jwt.claims', '{"sub":"wx:test_c","role":"authenticated"}', true) is not null as ok \gset
select set_config('app.test_item1', :'item1', true) is not null as ok \gset
do $$
declare
    v_plan bigint := current_setting('app.test_plan_id')::bigint;
    v_item bigint := current_setting('app.test_item1')::bigint;
    v_ok   int := 0;
begin
    begin perform public.plan_confirm(v_plan);           exception when others then v_ok := v_ok + 1; end;
    begin perform public.plan_get(v_plan);               exception when others then v_ok := v_ok + 1; end;
    begin perform public.plan_add_item(v_plan, 2, 'lunch', '入侵', '[]'::jsonb);
                                                          exception when others then v_ok := v_ok + 1; end;
    begin perform public.plan_remove_item(v_item);       exception when others then v_ok := v_ok + 1; end;
    begin perform public.plan_cook_item(v_item, '[]'::jsonb);
                                                          exception when others then v_ok := v_ok + 1; end;
    begin perform public.plan_cancel(v_plan);            exception when others then v_ok := v_ok + 1; end;
    if v_ok = 6 then
        raise notice 'T10.cross_space      | 6/6 全被拒 | PASS';
    else
        raise notice 'T10.cross_space      | 只有 %/6 被拒 | FAIL', v_ok;
    end if;
end $$;

-- T10.9 内部函数不可被客户端直调（plan_consume_items 收 space_id，能删别人冰箱）
do $$
begin
    perform public.plan_consume_items(1, '[]'::jsonb);
    raise notice 'T10.internal_exec    | 可直调 plan_consume_items | FAIL';
exception when insufficient_privilege then
    raise notice 'T10.internal_exec    | 42501 拒绝 | PASS';
end $$;


reset role;

\echo ''
\echo '########## T11 M12 营养聚合 ##########'
-- T11.1 加了两个 nutrition 列（且都是 jsonb 可空）
select 'T11.nutrition_col    ' as chk,
       count(*)::text || '/2',
       case when count(*) = 2 then 'PASS' else 'FAIL' end
  from information_schema.columns
 where table_schema = 'public'
   and column_name = 'nutrition'
   and table_name in ('recipe_favorite', 'consumption_log');

-- T11.2 打卡时把菜谱营养拷成快照
--   造一条带 nutrition 的菜谱 → 排进计划并绑定 recipe_id → 打卡 → 看 consumption_log。
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"wx:test_a","role":"authenticated"}', true) is not null as ok \gset

insert into public.recipe_favorite (space_id, title, ingredients, steps, nutrition)
values (:'a_space'::bigint, '营养测试菜', '[]'::jsonb, '[]'::jsonb,
        '{"kcal":520,"protein":38,"carb":40,"fat":22,"approx":true}'::jsonb)
returning id as nutri_recipe \gset

select id as nutri_plan from public.plan_ensure_week(current_date + 14) \gset
-- 必须「先加菜、后确认」：plan_add_item 要求 plan.status = drafted，
-- 反过来会抛「这周菜单已经确认过了」。T10 也是这个顺序。
select id as nutri_item
  from public.plan_add_item(:'nutri_plan'::bigint, 0, 'lunch', '营养测试菜', '[]'::jsonb,
                            :'nutri_recipe'::bigint) \gset
-- 同一份计划里再排一道「手打菜名」的菜：它没有 recipe_id，用来验证
-- 「无估算的餐不能算成 0 卡，但要计入餐数」。
select id as plain_item
  from public.plan_add_item(:'nutri_plan'::bigint, 1, 'lunch', '手打菜名', '[]'::jsonb) \gset

select count(*) as nutri_confirmed from public.plan_confirm(:'nutri_plan'::bigint) \gset
select (public.plan_cook_item(:'nutri_item'::bigint, '[]'::jsonb)) ->> 'dup' as nutri_dup \gset
select (public.plan_cook_item(:'plain_item'::bigint, '[]'::jsonb)) ->> 'dup' as plain_dup \gset

reset role;
select 'T11.snapshot         ' as chk,
       coalesce((select nutrition ->> 'kcal' from public.consumption_log
                  where idempotency_key = 'cook:' || :'nutri_item'), '(null)'),
       case when (select nutrition ->> 'kcal' from public.consumption_log
                   where idempotency_key = 'cook:' || :'nutri_item') = '520'
            then 'PASS 快照已写入' else 'FAIL' end;

-- T11.3 无菜谱的菜（手打菜名）不产生营养，不能算成 0 卡
select 'T11.no_recipe_null   ' as chk,
       case when (select nutrition from public.consumption_log
                   where idempotency_key = 'cook:' || :'plain_item') is null
            then 'PASS 无菜谱 → nutrition 为 null' else 'FAIL' end;

-- T11.4 聚合：同一天 4 条记录，kcal 只算有估算的那条，meals 算全部
--   ⚠️ nutrition_daily 返回的是**一个 jsonb 数组**（不是 setof），
--   所以必须 jsonb_array_elements 展开，直接写 `from nutrition_daily(30) x` 再
--   `x ->> 'kcal'` 拿到的是整个数组上的键，永远是 NULL —— 断言会静默变成空集。
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"wx:test_a","role":"authenticated"}', true) is not null as ok \gset
select 'T11.aggregate        ' as chk,
       coalesce((select string_agg(
                    (e ->> 'day') || ':kcal=' || (e ->> 'kcal')
                    || ',meals=' || (e ->> 'meals') || ',est=' || (e ->> 'estimated'), ' | ')
                 from public.nutrition_daily(30) nd,
                      jsonb_array_elements(nd) e
                where e ->> 'kcal' = '520'), '(none)'),
       case when (select count(*)
                    from public.nutrition_daily(30) nd,
                         jsonb_array_elements(nd) e
                   where (e ->> 'kcal')::int = 520
                     and (e ->> 'meals')::int >= 2
                     and (e ->> 'estimated')::int = 1) = 1
            then 'PASS 只算有估算的' else 'FAIL' end;

-- T11.5 跨家隔离：C 看不到 A 的营养（C 的库里一条都没有 → 空数组）
select set_config('request.jwt.claims', '{"sub":"wx:test_c","role":"authenticated"}', true) is not null as ok \gset
select 'T11.cross_space      ' as chk,
       coalesce((select count(*)::text
                   from public.nutrition_daily(30) nd,
                        jsonb_array_elements(nd) e), '0') || ' 行',
       case when (select count(*)
                    from public.nutrition_daily(30) nd,
                         jsonb_array_elements(nd) e) = 0
            then 'PASS C 看不到 A 的数' else 'FAIL' end;

reset role;

\echo ''
\echo '########## 汇总：上面的 FAIL 行即为问题；本脚本最后 rollback，不留数据 ##########'
rollback;
\echo 'ROLLBACK done.'