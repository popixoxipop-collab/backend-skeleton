package controllers

import javax.inject.Inject
import play.api.mvc._

class Users @Inject()(cc: ControllerComponents) extends AbstractController(cc) {
  def show(id: Long): Action[AnyContent] = Action { Ok(id.toString) }
  def create(): Action[AnyContent] = Action { Ok("created") }
}
