class Invoice < ActiveRecord::Base
  self.table_name = "invoices"
  self.primary_key = "id"
  default_scope { where(tenant_id: Current.tenant_id) }
end
