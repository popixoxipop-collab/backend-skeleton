ActiveRecord::Schema[8.1].define(version: 1) do
  create_table "invoices", force: :cascade do |t|
    t.integer "tenant_id", null: false
    t.integer "total_cents", null: false
    t.index ["tenant_id"], name: "index_invoices_on_tenant_id"
  end
end
