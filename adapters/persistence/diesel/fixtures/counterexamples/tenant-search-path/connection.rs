use diesel::prelude::*;

pub enum Tenant {
    A,
    B,
}

// The same unqualified table! declaration can hit different PostgreSQL schemas.
// These fixed SQL literals avoid interpolating tenant input; this is not executed here.
pub fn select_tenant_schema(connection: &mut PgConnection, tenant: Tenant) -> QueryResult<usize> {
    let statement = match tenant {
        Tenant::A => "SET search_path TO tenant_a",
        Tenant::B => "SET search_path TO tenant_b",
    };
    diesel::sql_query(statement).execute(connection)
}
