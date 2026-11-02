// A single-column joinable! must not be fabricated for a composite foreign key.
diesel::table! {
    invoice_lines (tenant_id, invoice_id) {
        tenant_id -> Text,
        invoice_id -> BigInt,
        account_id -> BigInt,
    }
}

#[derive(diesel::Identifiable)]
#[diesel(table_name = crate::schema::invoice_lines)]
#[diesel(primary_key(tenant_id, invoice_id))]
pub struct InvoiceLine {
    pub tenant_id: String,
    pub invoice_id: i64,
    pub account_id: i64,
}
