use diesel::prelude::*;

#[derive(Queryable, Selectable, Identifiable)]
#[diesel(table_name = crate::schema::accounts)]
#[diesel(primary_key(account_id))]
pub struct Account {
    pub account_id: i64,
    pub display_name: String,
}

#[derive(Queryable, Selectable, Identifiable, Associations)]
#[diesel(table_name = crate::schema::invoices)]
#[diesel(primary_key(invoice_id))]
#[diesel(belongs_to(Account, foreign_key = account_id))]
pub struct Invoice {
    pub invoice_id: i64,
    pub account_id: i64,
}
