const express = require('express');
const router = express.Router();
const Item = require('../models/item');
const Media = require('../models/media');
const {ObjectId} = require('mongodb');
const User = require('../models/user');
const mongoose = require('mongoose');
const conn = mongoose.createConnection(process.env.MONGO_DATABASE_URL);
const Grid = require('gridfs-stream');
const {not_authen_redirect, authen_redirect, none_rediret_not_authen, none_redirect_authen} = require('../app_compoents/protecting_routes');
// Grid.mongo = mongoose.mongo;

const ERR_CODE = 433;

let gfs; // this is what we are gonna use to retrieve images stored in the db
conn.once('open', ()=>{
    gfs = Grid(conn.db, mongoose.mongo);
    gfs.collection('uploads');
});


router.post('/additem', none_rediret_not_authen, async function (req, res) {
    try{
        // if(process.env.PRINT_REQUESTS === 'true') console.log(req.body);
        let item = new Item({_userId: ObjectId(req.user._id), content: req.body.content, childType: req.body.childType, _parentId: (req.body.parent) ? ObjectId(req.body.parent) : undefined});
        // media ids may need to be readjusted
        item.media = req.body.media;
        // if media field is not empty
        if(item.media){
            for(let i = 0; i < item.media.length; i++) {
                let media = await Media.findOne({_contentId: ObjectId(item.media[i]), _userId: ObjectId(req.user._id)});
                if (!media) throw new Error('one of the media id is invalid or not belong to you');
                let current_media_id = item.media[i];
                let same_media_items = await Item.find({media: current_media_id});
                if (same_media_items.length !== 0) throw new Error("This media content has been used in another item already");
            }
        }

        item.markModified('media');
        await item.save();

        // if the item is a child
        if(item.childType === "retweet" && item._parentId){
            var parent = await Item.findOne({_id: item._parentId});
            if(!parent) throw new Error('Parent not found');
            parent.retweeted += 1;
            await parent.save();
        }

        return res.send({status: "OK", id: item._id});
    }catch (err) {
        res.err_msg = err.message;
        res.status(ERR_CODE).send({status: "error", error: err.message});
    }
});


router.get('/item/:id', async function(req, res){

    try{
        let item = await Item.findOne({_id: req.params.id});
        if(!item) throw new Error('item not found');
        let user = await User.findOne({_id: item._userId});
        if(!user) throw new Error('user not found');
        let responseJson = {
            id: item._id,
            username: user.username,
            property: {likes: item.likes},
            retweeted: item.retweeted,
            content: item.content,
            timestamp: item.createdAt,
            media: item.media,
            parent: item._parentId,
            media: item.media,
            childType: item.childType
        };
        return res.send({status: "OK", item: responseJson});
    }catch (err) {
        res.err_msg = err.message;
        res.status(ERR_CODE).send({status: "error", error: err.message});
    }
});

// do we really need to delete all the childs of the deleted items? if so, we may need recursions, not using it atm
async function delete_child_items(child_items){
    for(let i = 0; i < child_items.length; i++){
        let current_item = child_items[i];
        let childs_of_current_items = Item.find({_parentId: current_item._id});
        if(childs_of_current_items.length > 0) await delete_child_items(childs_of_current_items);
        for(let j = 0; j < current_item.media.length; j++){
            let current_media_id = current_item.media[j];
            let deleted_media = await Media.findOneAndDelete({_contentId: current_media_id});
            if(!deleted_media) throw new Error('deleted media not found');
            let deleted_file = await gfs.findOneAndDelete({_id: deleted_media._contentId});
            if(!deleted_file) throw new Error('deleted file not found');
        }
        await current_item.delete();
    }
}

// this is easier, just delete the item and its associated media
async function delete_item_only(item){
    // finally delete the item
    for(let j = 0; j < item.media.length; j++){
        let current_media_id = item.media[j];
        let deleted_media = await Media.findOneAndDelete({_contentId: current_media_id});
        if(!deleted_media) throw new Error('deleted media not found');
        let deleted_file = await gfs.files.findOneAndDelete({_id: deleted_media._contentId});
        if(!deleted_file) throw new Error('deleted file not found');
    }
    await item.delete();
}

router.delete('/item/:id', none_rediret_not_authen, async function(req, res){
    try{
        let item = await Item.findOne({_id: req.params.id, _userId: req.user._id});
        if(!item) throw new Error('item not found or you do not own this item');

        // delete all the items with this as parents first, skipping this for the moment
        // let child_items = Item.find({_parentId: item._id});
        // await delete_child_items(child_items);

        // delete just this item only for now
        await delete_item_only(item);
        return res.send({status: "OK"});
    }catch (err) {
        res.err_msg = err.message;
        return res.status(ERR_CODE).send({status:"error", error: err.message});
    }
});

// TODO finishes the rest of the filter
router.post('/search', async function (req, res) {
    // if(process.env.PRINT_REQUESTS === 'true') console.log(req.body);
    try{
        let timestamp = (req.body.timestamp) ? req.body.timestamp * 1000 : Date.now();
        let limit = (req.body.limit) ? req.body.limit : 25;
        let ranking = (req.body.rank) ? req.body.rank : "interest";
        if(limit > 100) throw new Error('limit can not be more than 100');
        req.body.replies = (typeof req.body.replies === 'undefined') ? true : req.body.replies;

        // first filters by time stamp
        const query = {
            createdAt: {$lte: new Date(timestamp).toISOString()} // find the items in which the timestamp is less or equal
        };

        // filter by user name if username is provided
        if(req.body.username){
            let user = await User.findOne({username: req.body.username});
            query["_userId"] = (user) ? user._id: undefined;
        }

        // if query string is pass
        if(req.body.q && (req.body.q !== '')){
            query["$text"] = { $search: req.body.q}
        }

        // filter if child type is a reply
        if(!req.body.replies){
            query["childType"] = "reply";
        }

        let items = await Item.find(query);

        let responseItems = [];
        await Promise.all(items.map(
            async (current_item) => {
                let current_item_user = await User.findOne({_id: current_item._userId});
                if(!current_item_user) throw new Error('current item user not found');

                // filtered by items made by the user the logged in user is following
                if(req.body.following){
                    if(!req.isAuthenticated()) {
                        throw new Error('user needs to be logged in to use following in advance search');
                    }
                    if(!req.user.following.includes(current_item_user.username)) return;
                }

                // if hasMedia is passed
                if(req.body.hasMedia){
                    if(current_item.media.length === 0) return;
                }

                if(req.body.parent){
                    if(!current_item._parentId) return;
                    if(!(current_item._parentId.toString() === req.body.parent)) return;
                }

                let current_json = {
                    id: current_item._id,
                    username: current_item_user.username,
                    property: {likes: current_item.likes},
                    retweeted: current_item.retweeted,
                    content: current_item.content,
                    timestamp: new Date(current_item.createdAt).getTime(),
                    media: current_item.media,
                    parent: current_item._parentId,
                    media: current_item.media,
                    parent: (req.body.replies) ? current_item._parentId : undefined,
                    childType: current_item.childType
                }
                responseItems.push(current_json);
            }
        ));

        if(ranking === "time"){
            responseItems.sort((current, next) => {{
                return (current.timestamp > next.timestamp) ? -1 : 1; // if current is greater than next then return -1 else 1. -1 comes first
            }});
        } else if(ranking === "interest"){
            responseItems.sort((current, next) => {{
                return ((current.property.likes + current.retweeted) > (next.property.likes + next.retweeted)) ? -1 : 1;
            }});
        }

        // return the limit number of items
        responseItems = responseItems.slice(0, limit);
        return res.send({status: "OK", items: responseItems});
    }catch (err) {
        res.err_msg = err.message;
        return res.status(ERR_CODE).send({status: "error", error: err.message});
    }
});

router.post('/item/:id/like', none_rediret_not_authen, async function (req, res) {
    try{
        // if(process.env.PRINT_REQUESTS === 'true') console.log(req.body);
        let item = await Item.findOne({_id: req.params.id});
        if(!item) throw new Error('item not found');
        if(item.likeBy.includes(req.user.username) && req.body.like) throw new Error("user already liked this item");
        if(!item.likeBy.includes(req.user.username) && !req.body.like) throw new Error("user needs to like this item before he can unlike it");
        if(req.body.like) {
            item.likeBy.push(req.user.username);
        }else{
            let index = item.likeBy.indexOf(req.user.username);
            if (index > -1) item.likeBy.splice(index, 1);
        }
        item.likes += (req.body.like) ? 1 : -1;
        await item.save();
        return res.send({status:"OK"});
    }catch (err) {
        res.err_msg = err.message;
        return res.status(ERR_CODE).send({status: "error", error: err.message});
    }
});




module.exports = router;