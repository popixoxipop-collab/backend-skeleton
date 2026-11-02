// Authored planning fixture: macros are source expectations, not expanded evidence.
diesel::table! {
    accounts (account_id) {
        account_id -> BigInt,
        display_name -> Text,
    }
}

diesel::table! {
    invoices (invoice_id) {
        invoice_id -> BigInt,
        account_id -> BigInt,
    }
}

diesel::joinable!(invoices -> accounts (account_id));
diesel::allow_tables_to_appear_in_same_query!(accounts, invoices);
